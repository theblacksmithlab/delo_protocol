// Global injected by pear-electron into the WebView context.
declare const Pear: {
  config: {
    storage: string
  }
  exit: (code?: number) => void
  Window: {
    self: {
      minimize: () => void
      fullscreen: () => void
      close: () => void
    }
  }
}
