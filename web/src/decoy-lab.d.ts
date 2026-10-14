// The standalone TL-01 renderers are shared ES modules, with no app/API imports.
declare module '*decoy-lab/templates/low.js' {
  export function renderLow(root: HTMLElement,
    model: import('./components/profiles/preview/types').PreviewModel,
    handlers?: import('./components/profiles/preview/types').PreviewHandlers): void;
}
declare module '*decoy-lab/templates/medium.js' {
  export function renderMedium(root: HTMLElement,
    model: import('./components/profiles/preview/types').PreviewModel,
    handlers?: import('./components/profiles/preview/types').PreviewHandlers): void;
}
