// Fixed private shape facts only. No representation, alias or schema authority.
import { copyBoundedJson, utf8Size } from "../bounded-json.js";
type ObjectValue = Record<string, unknown>;
type ValueType = "missing" | "null" | "object" | "array" | "string" | "number" | "boolean" | "other";
const PATHS = { root: [], data: ["data"], response: ["response"], data_response: ["data", "response"], response_data: ["response", "data"] } as const;
const COLLECTIONS = ["items", "calendars", "calendarList", "calendar_list", "events"] as const;
const RECORD_FIELDS = ["id", "accessRole", "access_role", "summary", "name", "calendar_id", "calendarId", "status", "start", "end", "recurringEventId", "originalStartTime"] as const;
const CURSORS = ["nextPageToken", "next_page_token"] as const;
const FIELD_KEYS = new Set(["type", "minLength", "maxLength", "title", "description", "default", "examples", "deprecated", "$comment"]);
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const valueType = (value: unknown): ValueType => value === undefined ? "missing" : value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "other";
const outcome = (value: unknown): "missing" | "true" | "false" | "other" => value === undefined ? "missing" : value === true ? "true" : value === false ? "false" : "other";
type SchemaContext = "simple" | "composition" | "property_count" | "enum_const" | "non_object" | "missing_properties" | "missing" | "other";
function schemaContext(schema: unknown): SchemaContext {
  const node = object(schema);
  if (!node) return schema === undefined ? "missing" : "other";
  if (["anyOf", "oneOf", "allOf"].some((key) => node[key] !== undefined)) return "composition";
  if (node.minProperties !== undefined || node.maxProperties !== undefined) return "property_count";
  if (node.enum !== undefined || node.const !== undefined) return "enum_const";
  if (node.type !== "object") return "non_object";
  if (!object(node.properties)) return "missing_properties";
  return node.required === undefined || Array.isArray(node.required) ? "simple" : "other";
}
function declaredType(value: unknown, target: "string" | "object"): "exact" | "singleton_array" | "union" | "missing" | "other" {
  return value === undefined ? "missing" : value === target ? "exact" : Array.isArray(value) && value.includes(target) ? value.length === 1 ? "singleton_array" : "union" : "other";
}
interface CursorFacts {
  value: ValueType;
  declaredType: ReturnType<typeof declaredType>;
  required: boolean | "unknown";
  default: "missing" | "null" | "other" | "unknown";
  plainString: boolean | "unknown";
}
interface CollectionFacts {
  value: ValueType;
  declaredArray: boolean | "unknown";
  count?: number;
  first: { value: ValueType; fields: Record<typeof RECORD_FIELDS[number], ValueType> };
  itemSchema?: { context: SchemaContext; objectType: ReturnType<typeof declaredType>; arrayComposition: boolean; arrayValueConstraint: boolean; arrayDefault: "missing" | "null" | "other"; recordDefault: "missing" | "null" | "other" };
}
interface LocationFacts {
  value: ValueType;
  successful: { type: ValueType; outcome: ReturnType<typeof outcome> };
  successfull: { type: ValueType; outcome: ReturnType<typeof outcome> };
  error: ValueType;
  data: ValueType;
  response: ValueType;
  itemsArray: boolean;
  schema: { context: SchemaContext; objectType: ReturnType<typeof declaredType>; ancestorRestricted: boolean };
  cursors: Record<typeof CURSORS[number], CursorFacts>;
  collections: Record<typeof COLLECTIONS[number], CollectionFacts>;
}
export interface ComposioCalendarPageShapeFacts { bounded: boolean; locations?: Record<keyof typeof PATHS, LocationFacts> }
function bounded(value: unknown): unknown {
  const copy = copyBoundedJson(value, { maxNodes: 12_000, maxDepth: 18, maxSize: 256 * 1024, measure: utf8Size });
  return copy === undefined || Buffer.byteLength(JSON.stringify(copy), "utf8") > 256 * 1024 ? undefined : copy;
}
/** Only fixed paths/fields are projected; counts cap at501 and no string,
 * identifier, unknown name, schema fragment or returned number is retained. */
export function composioCalendarPageShapeFacts(compiledSchema: unknown, response: unknown): ComposioCalendarPageShapeFacts {
  const schema = bounded(compiledSchema), copy = bounded(response);
  if (schema === undefined || copy === undefined) return { bounded: false };
  const locations = {} as Record<keyof typeof PATHS, LocationFacts>;
  for (const location of Object.keys(PATHS) as (keyof typeof PATHS)[]) {
    let value: unknown = copy, definition: unknown = schema, ancestorRestricted = false;
    for (const key of PATHS[location]) {
      ancestorRestricted ||= schemaContext(definition) !== "simple";
      value = object(value)?.[key]; definition = object(object(definition)?.properties)?.[key];
    }
    const record = object(value) ?? {}, node = object(definition), properties = object(node?.properties);
    const uncertain = ancestorRestricted || schemaContext(definition) !== "simple";
    const cursors = {} as LocationFacts["cursors"], collections = {} as LocationFacts["collections"];
    for (const key of CURSORS) {
      const field = object(properties?.[key]);
      cursors[key] = {
        value: valueType(record[key]), declaredType: declaredType(field?.type, "string"),
        required: uncertain ? "unknown" : Array.isArray(node?.required) ? node.required.includes(key) : false,
        default: !field ? "unknown" : !own(field, "default") ? "missing" : field.default === null ? "null" : "other",
        plainString: uncertain ? "unknown" : !!field && field.type === "string" && !Object.keys(field).some((keyword) => !FIELD_KEYS.has(keyword)) && (!own(field, "default") || field.default === null),
      };
    }
    for (const key of COLLECTIONS) {
      const array = record[key], first = Array.isArray(array) ? array[0] : undefined, firstObject = object(first), field = object(properties?.[key]);
      const fields = {} as Record<typeof RECORD_FIELDS[number], ValueType>;
      for (const name of RECORD_FIELDS) fields[name] = valueType(firstObject?.[name]);
      const item = object(field?.items);
      collections[key] = { value: valueType(array), declaredArray: uncertain ? "unknown" : field?.type === "array" || (Array.isArray(field?.type) && field.type.includes("array")), ...(Array.isArray(array) ? { count: Math.min(array.length, 501) } : {}), first: { value: valueType(first), fields }, ...(field?.items !== undefined ? { itemSchema: {
        context: schemaContext(field.items), objectType: declaredType(item?.type, "object"), arrayComposition: ["anyOf", "oneOf", "allOf"].some((keyword) => field[keyword] !== undefined), arrayValueConstraint: field.enum !== undefined || field.const !== undefined || field.uniqueItems !== undefined,
        arrayDefault: !own(field, "default") ? "missing" as const : field.default === null ? "null" as const : "other" as const,
        recordDefault: !item || !own(item, "default") ? "missing" as const : item.default === null ? "null" as const : "other" as const,
      } } : {}) };
    }
    locations[location] = {
      value: valueType(value), successful: { type: valueType(record.successful), outcome: outcome(record.successful) }, successfull: { type: valueType(record.successfull), outcome: outcome(record.successfull) },
      error: valueType(record.error), data: valueType(record.data), response: valueType(record.response), itemsArray: Array.isArray(record.items),
      schema: { context: schemaContext(definition), objectType: declaredType(node?.type, "object"), ancestorRestricted }, cursors, collections,
    };
  }
  return { bounded: true, locations };
}
