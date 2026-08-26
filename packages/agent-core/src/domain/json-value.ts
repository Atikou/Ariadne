/** Provider-neutral, data-only JSON used by protected Agent artifacts. */
export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentJsonValue[]
  | { readonly [key: string]: AgentJsonValue };
