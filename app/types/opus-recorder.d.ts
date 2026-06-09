declare module 'opus-recorder' {
  interface RecorderOptions {
    encoderFrameSize?: number
    encoderSampleRate?: number
    maxFramesPerPage?: number
    numberOfChannels?: number
    encoderApplication?: number
    streamPages?: boolean
    bufferLength?: number
    encoderPath?: string
    mediaTrackConstraints?: boolean | MediaTrackConstraints
  }
  export default class Recorder {
    constructor(options?: RecorderOptions)
    ondataavailable: (page: Uint8Array) => void
    start(): Promise<void>
    stop(): Promise<void>
  }
}
