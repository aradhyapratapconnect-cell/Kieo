// agent-core/voice/stt.ts — SttEngine lands in KIEO-030.
export interface SttEngine {
  transcribe(audio: ArrayBuffer): Promise<string>
}
