import type { MuxAdapter } from "./index.ts";

export type MuxEnvironment = NodeJS.ProcessEnv;

export interface MuxFactoryOptions {
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface MuxProvider {
  id: string;
  matches(env: MuxEnvironment): boolean;
  create(options?: MuxFactoryOptions): MuxAdapter;
}

export function createMuxRegistry() {
  const providers: MuxProvider[] = [];
  return {
    registerMux(provider: MuxProvider): void {
      if (providers.some((registered) => registered.id === provider.id)) {
        throw new Error(`Mux provider already registered: ${provider.id}`);
      }
      providers.push(provider);
    },
    resolveMux(
      env: MuxEnvironment = process.env,
      options?: MuxFactoryOptions,
    ): MuxAdapter | undefined {
      return providers
        .find((provider) => provider.matches(env))
        ?.create({ ...options, env });
    },
  };
}

export const { registerMux, resolveMux } = createMuxRegistry();
