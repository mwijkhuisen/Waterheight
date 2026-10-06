// The owner chunk (P10a T12): loaded with `import('./features/owner/index.ts')` only when /runtime-config.json says
// "owner". It holds the owner banner and the BE-3 and LU-4 label translations; the schemas are ./contracts.ts.
export { OwnerBanner } from './OwnerBanner.tsx';
