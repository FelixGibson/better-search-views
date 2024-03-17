import { Component, Notice } from "obsidian";
import { around } from "monkey-around";
import { createPositionFromOffsets } from "./metadata-cache-util/position";
import { createContextTree } from "./context-tree/create/create-context-tree";
import { renderContextTree } from "./ui/solid/render-context-tree";
import BetterSearchViewsPlugin from "./plugin";
import { wikiLinkBrackets } from "./patterns";
import { DisposerRegistry } from "./disposer-registry";
import { dedupeMatches } from "./context-tree/dedupe/dedupe-matches";
import { exec, execSync } from "child_process";

const errorTimeout = 10000;

// todo: add types
function getHighlightsFromVChild(vChild: any) {
  const { content, matches } = vChild;
  const firstMatch = matches[0];
  const [start, end] = firstMatch;

  return content
    .substring(start, end)
    .toLowerCase()
    .replace(wikiLinkBrackets, "");
}

export class Patcher {
  private readonly wrappedMatches = new WeakSet();
  private readonly wrappedSearchResultItems = new WeakSet();
  private currentNotice: Notice;
  private triedPatchingSearchResultItem = false;
  private triedPatchingRenderContentMatches = false;
  private readonly disposerRegistry = new DisposerRegistry();
  private processedDeduped = new Set<string>();
  private cache = new Map<string, string>();

  constructor(private readonly plugin: BetterSearchViewsPlugin) {}

  patchComponent() {
    const patcher = this;
    this.plugin.register(
      around(Component.prototype, {
        addChild(old: Component["addChild"]) {
          return function (child: any, ...args: any[]) {
            const thisIsSearchView = this.hasOwnProperty("searchQuery");

            if (thisIsSearchView && !patcher.triedPatchingSearchResultItem) {
              patcher.triedPatchingSearchResultItem = true;
              try {
                patcher.patchSearchResultDom(child.dom);
              } catch (error) {
                patcher.reportError(
                  error,
                  "Error while patching Obsidian internals",
                );
              }
            }

            return old.call(this, child, ...args);
          };
        },
      }),
    );
    this.plugin.register(
      around(Component.prototype, {
        recomputeBacklink(old) {
          return function (...args) {
            console.log('recomputeBacklink has been called'); // Add your hook logic here
      
            // Call the original function
            return old.call(this, ...args);
          };
        },
      });
    )
  }

  patchSearchResultDom(searchResultDom: any) {
    const patcher = this;
    this.plugin.register(
      around(searchResultDom.constructor.prototype, {
        addResult(old: any) {
          return function (...args: any[]) {
            patcher.disposerRegistry.onAddResult(this);

            const result = old.call(this, ...args);

            if (!patcher.triedPatchingRenderContentMatches) {
              patcher.triedPatchingRenderContentMatches = true;
              try {
                patcher.patchSearchResultItem(result);
              } catch (error) {
                patcher.reportError(
                  error,
                  "Error while patching Obsidian internals",
                );
              }
            }

            return result;
          };
        },
        emptyResults(old: any) {
          return function (...args: any[]) {
            patcher.disposerRegistry.onEmptyResults(this);

            return old.call(this, ...args);
          };
        },
      }),
    );
  }
  addSpacesToText(text: string): string {
    // Match Chinese characters and English words separately
    const matches = text.match(/[\u4e00-\u9fff]|[\w']+/g);
  
    if (matches) {
      // Add spaces between Chinese characters and English words
      return matches.join(' ');
    } else {
      // If no matches, return the original text
      return text;
    }
  }

  patchSearchResultItem(searchResultItem: any) {
    const patcher = this;
    this.plugin.register(
      around(searchResultItem.constructor.prototype, {
        renderContentMatches(old: any) {
          return function (...args: any[]) {
            const result = old.call(this, ...args);

            // todo: clean this up
            if (
              patcher.wrappedSearchResultItems.has(this) ||
              !this.vChildren._children ||
              this.vChildren._children.length === 0
            ) {
              return result;
            }

            patcher.wrappedSearchResultItems.add(this);

            try {
              let someMatchIsInProperties = false;

              const matchPositions = this.vChildren._children.map(
                // todo: works only for one match per block
                (child: any) => {
                  const { content, matches } = child;
                  const firstMatch = matches[0];

                  if (Object.hasOwn(firstMatch, "key")) {
                    someMatchIsInProperties = true;
                    return null;
                  }

                  const [start, end] = firstMatch;
                  return createPositionFromOffsets(content, start, end);
                },
              );

              if (someMatchIsInProperties) {
                return result;
              }

              // todo: move out
              const highlights: string[] = this.vChildren._children.map(
                getHighlightsFromVChild,
              );

              const deduped = [...new Set(highlights)];
              const highlightsString = patcher.addSpacesToText(deduped.join(" "));
              if (patcher.cache.has(highlightsString)) {
                const cachedResult = this.cache.get(highlightsString);
                const potentialBacklinksSection = document.createElement("div");
                potentialBacklinksSection.textContent = cachedResult;
                this.el.appendChild(potentialBacklinksSection);
              } else {
                try {
                  const options = { 
                    cwd: '/home/felix/software/git-felix/Dropbox/Dropbox/logseq-obsidian-off1',
                    maxBuffer: 1024 * 1024 // Increase buffer to 10MB
                  };

                  const stdout = execSync(`grep --line-buffered --color=never -r "" * | fzf --filter="${highlightsString}"`, options).toString();
                  // this.cache.set(highlightsString, stdout);
                  const lines = stdout.split("\n");
                  // Create a new section for "potential backlinks" and add the results of the search to this section
                  // Now you can process each line individually
                  for (const line of lines) {
                    // Create a new section for "potential backlinks" and add the results of the search to this section
                    const potentialBacklinksSection = document.createElement("div");
                    potentialBacklinksSection.textContent = line;

                    // Add the new section to the search result item
                    this.el.appendChild(potentialBacklinksSection);
                  }
              
                } catch (error) {
                  patcher.reportError(
                    error,
                    `Failed to execute grep and fzf command for file path: ${this.file.path}`,
                  );
                }
                


              }

              const firstMatch = this.vChildren._children[0];
              patcher.mountContextTreeOnMatchEl(
                this,
                firstMatch,
                matchPositions,
                deduped,
                this.parent.infinityScroll,
              );

              // we already mounted the whole thing to the first child, so discard the rest
              this.vChildren._children = this.vChildren._children.slice(0, 1);
            } catch (e) {
              patcher.reportError(
                e,
                `Failed to mount context tree for file path: ${this.file.path}`,
              );
            }

            return result;
          };
        },
      }),
    );
  }

  reportError(error: any, message: string) {
    this.currentNotice?.hide();
    this.currentNotice = new Notice(
      `Better Search Views: ${message}. Please report an issue with the details from the console attached.`,
      errorTimeout,
    );
    console.error(`${message}. Reason:`, error);
  }

  mountContextTreeOnMatchEl(
    container: any,
    match: any,
    positions: any[],
    highlights: string[],
    infinityScroll: any,
  ) {
    if (this.wrappedMatches.has(match)) {
      return;
    }

    this.wrappedMatches.add(match);

    const { cache, content } = match;
    const { file } = container;

    const matchIsOnlyInFileName = !cache.sections || content === "";

    if (file.extension === "canvas" || matchIsOnlyInFileName) {
      return;
    }

    const contextTree = createContextTree({
      positions,
      fileContents: content,
      stat: file.stat,
      filePath: file.path,
      ...cache,
    });

    const mountPoint = createDiv();

    const dispose = renderContextTree({
      highlights,
      contextTree: dedupeMatches(contextTree),
      el: mountPoint,
      plugin: this.plugin,
      infinityScroll,
    });

    this.disposerRegistry.addOnEmptyResultsCallback(dispose);

    match.el = mountPoint;
  }
}
