import type { AriadneApi } from '../shared/contract';

declare global {
  interface Window {
    ariadne: AriadneApi;
  }
}

export {};
