// The owner chunk (P10a T12): loaded with `import('./features/owner/index.ts')` only when /runtime-config.json says
// "owner". It holds the owner banner and, on the Sources page (P10b), a personal-use source's basis; the BE-3 and LU-4
// label translations are ./labels.gen.ts and the schemas ./contracts.ts. P10b adds no chunk: the build test pins three.
export { OwnerBanner } from './OwnerBanner.tsx';
export { OwnerBasis } from './OwnerBasis.tsx';
