export interface ElectronFetchSource {
  fetch: typeof fetch;
}

export function createElectronFetch(source: ElectronFetchSource): typeof fetch {
  return (input, init) => source.fetch(input, init);
}
