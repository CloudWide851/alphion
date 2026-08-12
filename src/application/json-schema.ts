import { AlphionError } from "./errors.js";

export function validateJsonSchema(schema: Readonly<Record<string, unknown>>, value: unknown, path = "$"): void {
  if ("const" in schema && !Object.is(value, schema.const)) fail(path, "must equal const");
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) fail(path, "must match enum");
  const type = schema.type;
  if (type === "object") validateObject(schema, value, path);
  else if (type === "array") validateArray(schema, value, path);
  else if (type === "string") validateString(schema, value, path);
  else if (type === "number" || type === "integer") validateNumber(schema, value, path, type === "integer");
  else if (type === "boolean" && typeof value !== "boolean") fail(path, "must be boolean");
}

function validateObject(schema: Readonly<Record<string, unknown>>, value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be object");
  const record = value as Readonly<Record<string, unknown>>;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const key of Array.isArray(schema.required) ? schema.required : []) if (typeof key === "string" && !(key in record)) fail(`${path}.${key}`, "is required");
  if (schema.additionalProperties === false) for (const key of Object.keys(record)) if (!(key in properties)) fail(`${path}.${key}`, "is not allowed");
  for (const [key, subschema] of Object.entries(properties)) if (key in record && isRecord(subschema)) validateJsonSchema(subschema, record[key], `${path}.${key}`);
}

function validateArray(schema: Readonly<Record<string, unknown>>, value: unknown, path: string): void {
  if (!Array.isArray(value)) fail(path, "must be array");
  if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(path, "has too few items");
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(path, "has too many items");
  if (isRecord(schema.items)) value.forEach((item, index) => validateJsonSchema(schema.items as Readonly<Record<string, unknown>>, item, `${path}[${index}]`));
}

function validateString(schema: Readonly<Record<string, unknown>>, value: unknown, path: string): void {
  if (typeof value !== "string") fail(path, "must be string");
  if (typeof schema.minLength === "number" && value.length < schema.minLength) fail(path, "is too short");
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) fail(path, "is too long");
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) fail(path, "has invalid format");
}

function validateNumber(schema: Readonly<Record<string, unknown>>, value: unknown, path: string, integer: boolean): void {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) fail(path, integer ? "must be integer" : "must be number");
  if (typeof schema.minimum === "number" && value < schema.minimum) fail(path, "is below minimum");
  if (typeof schema.maximum === "number" && value > schema.maximum) fail(path, "is above maximum");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fail(path: string, reason: string): never { throw new AlphionError("validation", `Tool arguments ${path} ${reason}.`, { stage: "tool-validation" }); }
