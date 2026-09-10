// agent-core/voice/tts.ts — TtsEngine lands in KIEO-031.
export interface TtsEngine {
  speak(text: string): Promise<void>
}
