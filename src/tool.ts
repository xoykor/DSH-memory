/**
 * Tiny self-contained tool-definition helper for dsh-memory.
 *
 * DSH accepts raw JSON-Schema ToolDefinition objects directly. Keeping this
 * adapter local avoids a runtime import of @deepseek-ai/dsh-tools, which is a
 * host service package and may not be installed inside an out-of-tree profile
 * when pnpm uses autoInstallPeers: false.
 */

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

type SchemaSpec = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'
  required?: true
  description?: string
  title?: string
  default?: JsonValue
  examples?: JsonValue[]
  enum?: JsonPrimitive[]
  const?: JsonPrimitive
  items?: SchemaSpec
  properties?: Record<string, SchemaSpec>
  additionalProperties?: boolean
}

type JsonSchema = {
  type?: string
  description?: string
  title?: string
  default?: JsonValue
  examples?: JsonValue[]
  enum?: JsonPrimitive[]
  const?: JsonPrimitive
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
}

interface MemoryToolOptions {
  name: string
  description: string
  parameters: Record<string, SchemaSpec>
  output: {
    schema: SchemaSpec
    render: (args: any, value: any) => any[]
    presentationMeta?: (args: any, value: any) => JsonValue
  }
  presentCall?: (args: any) => any
  execute: (args: any, exec?: unknown) => Promise<any> | any
}

function compileAnnotations(spec: SchemaSpec, target: JsonSchema): void {
  if (spec.description !== undefined) target.description = spec.description
  if (spec.title !== undefined) target.title = spec.title
  if (spec.default !== undefined) target.default = spec.default
  if (spec.examples !== undefined) target.examples = spec.examples
  if (spec.enum !== undefined) target.enum = spec.enum
  if (spec.const !== undefined) target.const = spec.const
}

function compileProperties(
  properties: Record<string, SchemaSpec>,
): { properties: Record<string, JsonSchema>; required?: string[] } {
  const compiled: Record<string, JsonSchema> = {}
  const required: string[] = []

  for (const [key, spec] of Object.entries(properties)) {
    compiled[key] = compileSchema(spec)
    if (spec.required === true) required.push(key)
  }

  return required.length > 0
    ? { properties: compiled, required }
    : { properties: compiled }
}

function compileSchema(spec: SchemaSpec): JsonSchema {
  if (spec.type === 'json') {
    const schema: JsonSchema = {}
    compileAnnotations(spec, schema)
    return schema
  }

  const schema: JsonSchema = { type: spec.type }
  compileAnnotations(spec, schema)

  if (spec.type === 'array' && spec.items !== undefined) {
    schema.items = compileSchema(spec.items)
  }

  if (spec.type === 'object') {
    const compiled = compileProperties(spec.properties ?? {})
    schema.properties = compiled.properties
    if (compiled.required !== undefined) schema.required = compiled.required
    if (spec.additionalProperties !== undefined) {
      schema.additionalProperties = spec.additionalProperties
    }
  }

  return schema
}

function compileParameters(parameters: Record<string, SchemaSpec>): JsonSchema {
  const compiled = compileProperties(parameters)
  return {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateSchema(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = []
  const label = path.length > 0 ? path : 'value'

  if (schema.const !== undefined && value !== schema.const) {
    return [`${label} must equal the declared constant`]
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as JsonPrimitive)) {
    return [`${label} must be one of the declared values`]
  }

  switch (schema.type) {
    case undefined:
      return errors
    case 'string':
      if (typeof value !== 'string') errors.push(`${label} must be a string`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${label} must be a finite number`)
      }
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${label} must be an integer`)
      }
      break
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${label} must be a boolean`)
      break
    case 'null':
      if (value !== null) errors.push(`${label} must be null`)
      break
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${label} must be an array`)
      } else if (schema.items !== undefined) {
        value.forEach((item, index) => {
          errors.push(...validateSchema(schema.items!, item, `${label}[${index}]`))
        })
      }
      break
    case 'object': {
      if (!isObject(value)) {
        errors.push(`${label} must be an object`)
        break
      }
      const properties = schema.properties ?? {}
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`${label}.${key} is required`)
      }
      for (const [key, item] of Object.entries(value)) {
        const child = properties[key]
        if (child !== undefined) {
          errors.push(...validateSchema(child, item, path.length > 0 ? `${path}.${key}` : key))
        } else if (schema.additionalProperties === false) {
          errors.push(`${label}.${key} is not allowed`)
        }
      }
      break
    }
  }

  return errors
}

/**
 * Convert dsh-memory's compact author schema into the raw ToolDefinition shape
 * accepted by the DSH tool registry.
 */
export function defineMemoryTool(options: MemoryToolOptions): any {
  const parameters = compileParameters(options.parameters)
  const outputSchema = compileSchema(options.output.schema)

  const validateArgs = (args: unknown): string[] => validateSchema(parameters, args, '')

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
      ...(options.output.presentationMeta === undefined
        ? {}
        : { presentationMeta: options.output.presentationMeta }),
    },
    async execute(args: unknown, exec: unknown): Promise<any> {
      const violations = validateArgs(args)
      if (violations.length > 0) {
        throw new Error(`invalid arguments: ${violations.join('; ')}`)
      }
      return options.execute(args, exec)
    },
    ...(options.presentCall === undefined
      ? {}
      : {
          presentCall(args: unknown): any {
            if (validateArgs(args).length > 0) return undefined
            return options.presentCall!(args)
          },
        }),
  }
}
