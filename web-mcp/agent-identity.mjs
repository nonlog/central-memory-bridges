// An Executor-routed write may carry an agent-selected source label.
// This is explicit attribution, not a verified identity of the calling program.
export const EXECUTOR_AGENT_IDENTITIES = Object.freeze([
  'executor', 'claude', 'codex', 'chatgpt', 'gemini', 'claude-web',
  'grok-web', 'muse-web', 'pi', 'omp', 'hermes', 'openclaw'
]);

export function resolveMemorySource(authenticatedPlatform, selectedIdentity) {
  if (authenticatedPlatform !== 'executor') return authenticatedPlatform;
  if (selectedIdentity === undefined) return 'executor';
  if (!EXECUTOR_AGENT_IDENTITIES.includes(selectedIdentity)) {
    throw new Error('Unsupported agent_identity; select a listed identity or omit to use executor');
  }
  return selectedIdentity;
}
