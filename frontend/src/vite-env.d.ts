/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Address of the backend when it is hosted on a different site. Empty in local development. */
  readonly VITE_API_URL?: string;
}
