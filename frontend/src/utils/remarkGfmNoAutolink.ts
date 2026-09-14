/**
 * GFM parsing without autolink literals (#86).
 *
 * `remark-gfm` imports `mdast-util-gfm-autolink-literal`, whose module
 * contains a regex lookbehind that Safari 16.0-16.3 cannot parse. Because the
 * module is statically imported through FolderReadmePanel, that one regex can
 * prevent the entire SPA from compiling. Compose the four GFM extensions the
 * README uses and deliberately omit autolink literals. Explicit markdown links
 * and angle-bracket links remain supported by core markdown.
 */

import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import type { Processor } from 'unified';
import type {} from 'remark-parse';

export default function remarkGfmNoAutolink(this: Processor): undefined {
  const data = this.data();
  const micromarkExtensions = data.micromarkExtensions || (data.micromarkExtensions = []);
  const fromMarkdownExtensions = data.fromMarkdownExtensions || (data.fromMarkdownExtensions = []);

  micromarkExtensions.push(gfmFootnote(), gfmStrikethrough(), gfmTable(), gfmTaskListItem());
  fromMarkdownExtensions.push(
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown(),
  );
}
