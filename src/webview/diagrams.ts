export type DiagramTheme = 'dark' | 'default'

/** Returns the SVG of a diagram, and rejects when its source is not valid */
export type DiagramRenderer = (source: string, theme: DiagramTheme) => Promise<string>

declare global {
  interface Window {
    /** Set by the `mermaid.js` bundle, which is loaded when the first diagram is found */
    ghPrRenderDiagram?: DiagramRenderer
  }
}

type Rendered = { svg: string } | { error: string }

// read while the script of the page runs, it is `null` afterwards
const pageScript = document.currentScript

let renderer: Promise<DiagramRenderer> | undefined

/** The library is large, so it is a separate script that most pages never load */
function loadRenderer(): Promise<DiagramRenderer> {
  renderer ??= new Promise((resolve, reject) => {
    if (!(pageScript instanceof HTMLScriptElement)) {
      reject(new Error('The script of the page was not found'))
      return
    }
    const script = document.createElement('script')
    script.src = new URL('mermaid.js', pageScript.src).toString()
    // the page only runs scripts that carry its nonce
    script.nonce = pageScript.nonce
    script.addEventListener('load', () => {
      if (window.ghPrRenderDiagram) resolve(window.ghPrRenderDiagram)
      else reject(new Error('The diagram renderer did not start'))
    })
    script.addEventListener('error', () => {
      reject(new Error('The diagram renderer could not be loaded'))
    })
    document.head.append(script)
  })
  return renderer
}

export function diagramTheme(): DiagramTheme {
  const { classList } = document.body
  return classList.contains('vscode-dark') || classList.contains('vscode-high-contrast') ?
      'dark'
    : 'default'
}

/**
 * The page is rebuilt on every change of the pull request. A diagram that was
 * already rendered is kept here, so that it is shown again without a flicker.
 */
const results = new Map<string, Rendered | Promise<Rendered>>()

function renderDiagram(source: string, theme: DiagramTheme): Rendered | Promise<Rendered> {
  const key = `${theme}\n${source}`
  const cached = results.get(key)
  if (cached) return cached

  const promise = loadRenderer()
    .then((render) => render(source, theme))
    .then(
      (svg): Rendered => ({ svg }),
      (error: unknown): Rendered => ({
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((result) => {
      results.set(key, result)
      return result
    })
  results.set(key, promise)
  return promise
}

function showDiagram(section: Element, result: Rendered): void {
  if ('error' in result) {
    // the source of the diagram stays visible above the reason
    const note = document.createElement('div')
    note.className = 'diagram-error'
    note.textContent = `Could not render the diagram: ${result.error}`
    section.querySelector('.diagram-error')?.remove()
    section.append(note)
    return
  }
  const diagram = document.createElement('div')
  diagram.className = 'diagram'
  // the renderer sanitizes the SVG, and the page does not run inline scripts
  diagram.innerHTML = result.svg
  section.replaceChildren(diagram)
}

/**
 * GitHub sends a diagram as its source and a spinner, and draws it with a
 * script of its own page. Draws the mermaid diagrams of `root` here instead.
 */
export function renderDiagrams(root: HTMLElement): void {
  for (const section of root.querySelectorAll('section.js-render-needs-enrichment')) {
    // nothing replaces the spinner here, also not for the kinds that are not drawn
    section.querySelector('.js-render-enrichment-loader')?.remove()
    if (section.getAttribute('data-type') !== 'mermaid') continue

    const source =
      section.querySelector('[data-plain]')?.getAttribute('data-plain') ??
      section.querySelector('pre')?.textContent
    if (!source?.trim()) continue

    const result = renderDiagram(source, diagramTheme())
    if (result instanceof Promise) {
      void result.then((rendered) => showDiagram(section, rendered))
    } else {
      showDiagram(section, result)
    }
  }
}

/** The colors of a diagram are part of its SVG, so it is drawn again for another theme */
export function onDiagramThemeChange(listener: () => void): void {
  let theme = diagramTheme()
  new MutationObserver(() => {
    const next = diagramTheme()
    if (next === theme) return
    theme = next
    listener()
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] })
}
