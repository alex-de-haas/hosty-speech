export class SpeechError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = "SpeechError"; }
}
