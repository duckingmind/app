import type { AgentCapabilityDeclaration, AgentContractMetadata } from '@ducking-mind/proxy-app-sdk'

export const agentMetadata: AgentContractMetadata
export const capabilities: readonly AgentCapabilityDeclaration[]
export function capability(name: string): AgentCapabilityDeclaration
