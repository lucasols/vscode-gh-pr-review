import mermaid from 'mermaid'
// only the type is imported, the page and this script are separate bundles
import type { DiagramRenderer } from './diagrams'

let count = 0

const renderDiagram: DiagramRenderer = async (source, theme) => {
  mermaid.initialize({
    startOnLoad: false,
    // the source comes from the author of the pull request
    securityLevel: 'strict',
    // a failure is reported by the page, not drawn as a diagram
    suppressErrorRendering: true,
    theme,
  })
  count += 1
  const { svg } = await mermaid.render(`gh-pr-diagram-${count}`, source)
  return svg
}

window.ghPrRenderDiagram = renderDiagram
