import type { AgentCapabilityDeclaration, AgentContractMetadata } from '@ducking-mind/proxy-app-sdk'

export const agentMetadata: AgentContractMetadata
export function getAgentCapabilities(): AgentCapabilityDeclaration[]
export function registerAgentTools(
  registry: { register(declaration: AgentCapabilityDeclaration, handler?: ((input: any, context: any) => unknown) | undefined): (() => void) | undefined },
  handlers?: Record<string, (input: any, context: any) => unknown>,
): Array<() => void>
export function capability(name: string): AgentCapabilityDeclaration
