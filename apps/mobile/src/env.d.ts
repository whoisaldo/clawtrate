// What Metro gives a module beside the language: an image import, which is the
// asset's number.
declare module "*.png" {
  const asset: number;
  export default asset;
}
