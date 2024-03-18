import { Component, LinkCache, Notice, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
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

  constructor(private readonly plugin: BetterSearchViewsPlugin) { }

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

    // this.plugin.app.workspace.onLayoutReady(() => {
    //   const activeEditor: any = this.plugin.app.workspace.activeEditor;
    //   const backlink = activeEditor?.backlinks;
    //   if (backlink != null) {
    //     console.log("fdafdf");
    //   }
    // });
    this.plugin.app.workspace.on('active-leaf-change', () => {
      const activeEditor: any = this.plugin.app.workspace.activeEditor;
      const backlink = activeEditor?.backlinks;
      const file = this.plugin.app.workspace.getActiveFile();
      const basename = file?.basename ?? "";
      if (backlink != null) {
        const highlightsString = patcher.addSpacesToText(basename);
        // backlink.unlinkedCollapsed = false;
        if (backlink.unlinkedCollapsed == true) {
          backlink.unlinkedHeaderEl.click();
        }
        if (backlink.extraContext == false) {
          backlink.extraContextButtonEl.click();
        }
        try {
          let adapter: any = this.plugin.app.vault.adapter;
          const pathToFzf = '/opt/homebrew/bin'; // Replace with the actual path to fzf
          const modifiedPath = `${process.env.PATH}:${pathToFzf}`;
          
          const options = {
              env: {
                  ...process.env,
                  PATH: modifiedPath,
              },
              cwd: adapter.getBasePath(),
              maxBuffer: 10 * 1024 * 1024 // Increase buffer to 10MB
          };

          const stdout = execSync(`grep --line-buffered --color=never -r "" * | fzf --filter="${highlightsString}"`, options).toString().trim();
          // this.cache.set(highlightsString, stdout);
          const lines = stdout.split("\n");
                    
          // Find the unlinkedHeaderEl in the backlink object
          const unlinkedHeaderEl = backlink?.unlinkedHeaderEl as HTMLElement;
          if (unlinkedHeaderEl) {
            // Check if a "potential mentions" section already exists
            const parentNode = unlinkedHeaderEl.parentNode;
            if (parentNode) {
              const existingSection = Array.from(parentNode.children).find((child: HTMLElement) => child.id === 'potentialMentions');
              if (existingSection) {
                // If it does, remove it
                if (existingSection.parentNode) {
                  existingSection.parentNode.removeChild(existingSection);
                }
              }
              const existingLines = Array.from(parentNode.children).filter((child: HTMLElement) => child.id === 'potentialMentionLine');
              for (const line of existingLines) {
                if (line.parentNode) {
                  line.parentNode.removeChild(line);
                }
              }
              // Create a new section for "potential mentions"
              const potentialMentionsSection = document.createElement("div");
              potentialMentionsSection.id = 'potentialMentions';
              potentialMentionsSection.textContent = "Potential mentions";
              potentialMentionsSection.className = unlinkedHeaderEl.className;
              unlinkedHeaderEl.parentNode.appendChild(potentialMentionsSection);

              // Process each line individually
              for (const line of lines) {
                if (line.toLowerCase().includes(basename.toLowerCase())) {
                  continue;
                }
                // Parse the line to extract the path, basename, and content
                const [filePath, content] = line.split(":");
                // const pathParts = filePath.split("/");
                // const basenameOfContent = pathParts[pathParts.length - 1];
                const tfile: any = this.plugin.app.vault.getAbstractFileByPath(filePath);
                if (tfile == null) {
                  continue;
                }

                // Create a new child element for the line
                const lineElement = document.createElement("div");
                lineElement.textContent = line;
                lineElement.id = 'potentialMentionLine';
                lineElement.className = unlinkedHeaderEl.className;
                lineElement.addEventListener("click", async () => {
                  const activeLeaf: WorkspaceLeaf = this.plugin.app.workspace.getLeaf();

                  const fileText: string = await this.plugin.app.vault.read(tfile);
                  //find start index of card
                  const startIndex = fileText.search(content.trim());
                  if (startIndex != -1) {
                      const n = {
                          match: {
                              content: fileText,
                              matches: [[startIndex, startIndex + content.length]],
                          },
                      };
                      activeLeaf.openFile(tfile, {
                          active: true,
                          eState: n,
                      });
                  } 
                  else {
                    await activeLeaf.openFile(tfile);
                    // const activeView: MarkdownView =
                    //     this.app.workspace.getActiveViewOfType(MarkdownView);
                    // activeView.editor.setCursor({
                    //     line: this.currentCard.lineNo,
                    //     ch: 0,
                    // });
                    // activeView.editor.scrollTo(this.currentCard.lineNo, 0);
                }
              });
                // Add the child element to the "potential mentions" section
                unlinkedHeaderEl.parentNode.appendChild(lineElement);
              }

            }
          }

        } catch (error) {
          patcher.reportError(
            error,
            `Failed to execute grep and fzf command for file path: ${basename}`,
          );
        }
      }

    });

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
      // Add "'" before English words and spaces between Chinese characters and English words
      const processedMatches = matches.map(match => {
        // Check if the match is an English word by checking if it contains any ASCII characters
        if (/[A-Za-z0-9_]/.test(match)) {
          // If it's an English word, prepend it with "'"
          return "'" + match;
        } else {
          // If it's not an English word, return it as is
          return match;
        }
      });
  
      return processedMatches.join(' ');
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
