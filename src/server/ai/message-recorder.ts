import type { ResultAsync } from "neverthrow"

import type { AiMessage, AiProviderError } from "./ai-provider"

/** Persists provider-neutral messages produced during one conversation turn. */
export interface AiMessageRecorder {
  recordMessages: (
    messages: readonly AiMessage[]
  ) => ResultAsync<void, AiProviderError>
}
