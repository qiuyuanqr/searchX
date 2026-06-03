import { renderCard } from "./render-card.js";

export function renderIndex(entries, template) {
  const cards = entries.map(renderCard).join("\n");
  return template.replace("<!-- CARDS -->", cards);
}
