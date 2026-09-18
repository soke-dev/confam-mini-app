/**
 * Font files, imported as modules.
 *
 * Metro turns an asset import into a module id that expo-asset resolves to a
 * URL. TypeScript has no idea about any of that and refuses the import, so
 * this tells it the shape. expo-env.d.ts covers the assets Expo declares for
 * itself; a .ttf reached for directly inside a package is not among them.
 */
declare module '*.ttf' {
  const asset: number;
  export default asset;
}
