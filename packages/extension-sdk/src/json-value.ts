// Whether a value can cross the Studio protocol as JSON, and if not, why.
//
// A module's event payload is sent to clients as JSON. `JSON.stringify` alone
// would not do as the check: it turns a Date into a string, NaN into null and
// a Map into `{}`, so the module's client half would read something other than
// what was emitted, silently. This walks the value and names the first part
// that would not arrive as sent.

/**
 * Null when `value` is a JSON value through and through (plain objects,
 * arrays, strings, finite numbers, booleans and null; an object member that is
 * `undefined` is left out, as JSON leaves it), or the reason it is not, naming
 * where: `payload.at is a Date, not a plain object`.
 */
export function jsonValueProblem(value: unknown, path = 'payload'): string | null {
  return problemAt(value, path, [])
}

function problemAt(value: unknown, path: string, ancestors: object[]): string | null {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null
    case 'number':
      if (Number.isNaN(value)) return `${path} is NaN`
      return Number.isFinite(value) ? null : `${path} is ${value > 0 ? 'Infinity' : '-Infinity'}`
    case 'undefined':
      return `${path} is undefined, which JSON cannot carry`
    case 'function':
      return `${path} is a function, which JSON cannot carry`
    case 'bigint':
      return `${path} is a bigint, which JSON cannot carry`
    case 'symbol':
      return `${path} is a symbol, which JSON cannot carry`
  }
  const object = value as object
  // A value seen twice down different branches is fine; one that contains itself is not.
  if (ancestors.includes(object)) return `${path} refers back to itself`
  const inner = [...ancestors, object]
  if (Array.isArray(object)) {
    for (let index = 0; index < object.length; index += 1) {
      const problem = problemAt(object[index], `${path}[${index}]`, inner)
      if (problem) return problem
    }
    return null
  }
  const prototype = Object.getPrototypeOf(object) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (prototype as { constructor?: { name?: unknown } }).constructor?.name
    return `${path} is a ${typeof name === 'string' && name.length > 0 ? name : 'class instance'}, not a plain object`
  }
  for (const [key, member] of Object.entries(object)) {
    if (member === undefined) continue
    const problem = problemAt(member, `${path}.${key}`, inner)
    if (problem) return problem
  }
  return null
}
