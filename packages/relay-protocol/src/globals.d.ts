// The only runtime globals the relay protocol relies on. Node, Electron, Workers and
// React Native provide them; declaring them here keeps DOM and Node types out.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}

/** For the relay origin. Node, Electron and Workers have a full URL; the phone does not call it. */
declare class URL {
  constructor(input: string, base?: string);
  readonly protocol: string;
  readonly host: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}
