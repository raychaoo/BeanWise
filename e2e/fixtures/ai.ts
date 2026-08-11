/**
 * M7 E2E 工具（薄 re-export，单一实现，避免两套 helper 漂移——sync fixture 同模式）。
 */
export { chatCompletion, startAiServer } from '../../src/main/ai-test-server'
export type { AiServer } from '../../src/main/ai-test-server'
