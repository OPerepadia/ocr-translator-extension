# Translation overlay

The overlay paints translations over the image, on top of the original text.

```text
OCR result (lines, paragraphs, bubbles)
  -> one card per paragraph: pick font and width
  -> place each card, move overlapping cards apart
  -> color each card from the image around it
```

Code: [`overlay-layout.ts`](../src/entrypoints/content/overlay-layout.ts) (geometry), [`overlay.ts`](../src/entrypoints/content/overlay.ts) (cards and fitting), [`overlay-background.ts`](../src/entrypoints/content/overlay-background.ts) (colors).

## Cards

Each OCR paragraph gets one card with its translated line. If the translation has a different number of lines, the whole capture gets one combined card instead.

A card may use the area of its source text. Vertical text gets a wider area, since a translation does not fit a narrow column. Text in a speech bubble may also use the room inside the bubble; the layout model finds the bubbles (see [Text layout grouping](LAYOUT-GROUPING.md)).

## Font and width

- **Vertical text:** the font follows the column width, so the translation looks about as large as the original.
- **Horizontal text:** the largest font that fits. Titles and other large text may get a larger font, in step with the line height.

The card then takes the narrowest width that keeps the text from growing taller or splitting words. In a bubble, it fills the bubble with even lines instead.

If the text does not fit, the font shrinks to a minimum. After that, words may be hyphenated, and the rest is cut at a whole line. The full text is in the popover.

## Position and color

A card is centered on its source text, so it covers the original. A card in a bubble is shifted back inside the bubble if it spills out, and a tilted card is tilted like its text.

When horizontal text sits on a uniform background, its card is extended over the whole source text, stopping at the edges of other cards. A truncated translation also gets the free room around the text.

Overlapping cards are moved apart. Each pair moves the shorter way, sideways or up and down, but a card never leaves its source text or its bubble, and all cards stay inside the capture. On a crowded page some overlap can remain. Cards keep their place on the page when it scrolls.

The card takes the most common color around the text, so it blends into the image. The text is dark or white, whichever reads better.

## Views

- **Translation view:** the cards.
- **Original view:** an invisible copy of the recognized text over the image, so the original can be selected.

Resting the pointer on a card opens a popover with the translation and the original. Shift switches the views.

## Editing recognized text

The pencil in the popover opens an editor for the recognized text. The original view is shown meanwhile, so the text in the image can be read. The correction replaces the paragraph's line in the recognized text, and the whole text is translated again.

Line boxes do not change. The corrected text is spread over them by matching it to the recognized characters (see [`text-correction.ts`](../src/entrypoints/content/text-correction.ts)), so the text selected in the original view is corrected too.
