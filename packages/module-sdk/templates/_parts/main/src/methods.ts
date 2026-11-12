// The methods the main half declares and the window half calls: one contract,
// imported by both, so a call and its handler cannot disagree on a shape.
export type MainMethods = {
  status: { access: 'read'; params: Record<string, never>; result: { startedAt: number } }
}
