import { Component, LinkCache, Notice, Platform, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { around } from "monkey-around";
import { createPositionFromOffsets } from "./metadata-cache-util/position";
import { createContextTree } from "./context-tree/create/create-context-tree";
import { renderContextTree } from "./ui/solid/render-context-tree";
import BetterSearchViewsPlugin from "./plugin";
import { wikiLinkBrackets } from "./patterns";
import { DisposerRegistry } from "./disposer-registry";
import { dedupeMatches } from "./context-tree/dedupe/dedupe-matches";
import { exec, execSync } from "child_process";
import axios from "axios";
import Fuse, { RangeTuple } from 'fuse.js'


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


interface SearchMatch {
  path: string;
  line: string;
  indices: number[][];
  score: number;
}




// function scrollToTextInEditor(editor, text) {
//   // Create a search cursor that finds the text in the document
//   let cursor = editor.getSearchCursor(text);
//   let found = cursor.findNext();

//   if (found) {
//     // If the text was found, scroll to the text's position
//     editor.scrollIntoView({ from: cursor.from(), to: cursor.to() }, 200);
//     // Optionally highlight the text
//     editor.setSelection(cursor.from(), cursor.to());
//   } else {
//     console.log('Text not found in the document');
//   }
// }

// async function openFileAndScrollToText(filePath, searchText) {
//   // Open the file
//   await app.workspace.openLinkText(filePath, '', true);

//   // Get the active view
//   let activeLeaf = app.workspace.activeLeaf;
//   if (activeLeaf) {
//     let markdownView = activeLeaf.view;

//     if (markdownView instanceof obsidian.MarkdownView) {
//       // Wait for the editor to be ready if needed
//       setTimeout(() => {
//         // Get editor instance
//         let editor = markdownView.editor;
//         scrollToTextInEditor(editor, searchText);
//       }, 50); // A short delay to ensure the editor is initialized
//     }
//   }
// }

export class Patcher {
  private readonly wrappedMatches = new WeakSet();
  private readonly wrappedSearchResultItems = new WeakSet();
  private currentNotice: Notice;
  private triedPatchingSearchResultItem = false;
  private triedPatchingRenderContentMatches = false;
  private readonly disposerRegistry = new DisposerRegistry();
  private cancelTokenSource = axios.CancelToken.source();

  constructor(private readonly plugin: BetterSearchViewsPlugin) { }

  escapeRegExp(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
  }

  preprocess(highlightsString: string) {
    // const regex = /[^a-zA-Z0-9\s\u4e00-\u9fa5]/g;
    // highlightsString = highlightsString.replace(regex, ' ');
    return highlightsString;
  }
  

  async findPotentialBackLinks(highlightsString: string, placeHolder: any): Promise<SearchMatch[]> {
    const notes: TFile[] = this.plugin.app.vault.getMarkdownFiles();
    const searchResults: SearchMatch[] = [];
  
    for (const note of notes) {
      const fileText: string = await this.plugin.app.vault.read(note);
      const lines = fileText.split('\n');
  
      const fuse = new Fuse(lines, {
        includeScore: true,
        threshold: 0.4,
        includeMatches: true // Include match indices
      });
  
      const results = fuse.search(highlightsString);
      results.forEach(result => {
        if (result.matches && result.matches.length > 0) {
          const indices = result.matches[0].indices.map(range => [...range]); // Create a mutable copy
          searchResults.push({
            path: note.path,
            line: result.item,
            indices: indices,
            score: result.score ?? 0
          });
        }
      });
    }
  
    return searchResults;
  }

  async getAliasLines(aliases: string[], options: any): Promise<SearchMatch[]> {
    const aliasLines: SearchMatch[] = [];
  
    for (const alias of aliases) {
      const processedAlias = this.preprocess(alias);
      const aliasHighlightsString = this.addSpacesToText(processedAlias);
      const aliasStdout = await this.findPotentialBackLinks(aliasHighlightsString, options);
      aliasLines.push(...aliasStdout);
    }
  
    return aliasLines;
  }

  async associatedFromCoze(query: string): Promise<string> {
    try {
      const response = await axios.post('https://api.coze.com/open_api/v2/chat', {
        bot_id: "7347973296270802962",
        user: "29032201862555",
        query: query,
        stream: false
      }, {
        headers: {
          'Authorization': 'Bearer sgFk2tyDFgrUsIdQDOMhQ5Fc4jx1Rtz8AaTnQfi17mfomr38Z2Wy63FoG9xRmRR1',
          'Content-Type': 'application/json',
          'Accept': '*/*'
        },
        cancelToken: this.cancelTokenSource.token
      });
  
      if (response.data && response.data.messages && response.data.messages.length > 0) {
        // Assuming you always want the first message's content
        return response.data.messages[0].content;
      }
  
  
    } catch (error) {
      console.error('Error fetching content from Coze:', error);
    }
    return "";
  }


  // Call `associatedFromCoze`, use `findPotentialBackLinks` with its result, update UI asynchronously
  async useKeywordsAndUpdateUI(query: string, option: any, basename: string, aliases: string[], backlink: any, existingLines: string[]) {
    // this.associatedFromCoze(basename).catch(error => {
    //   this.reportError(
    //     error,
    //     "Error while query coze",
    //   );
    //   return "";
    // }).then(response => {
    //   if (response == "") {
    //     return;
    //   }
    //   console.log("response is " + response);
    //   const jsonObject = JSON.parse(response);
    //   // Assuming response is already parsed JSON as your structure
    //   const keywords = jsonObject.iterations[0].keywords;
    //   const translatedKeywords = jsonObject.iterations[0].translatedKeywords;
    //   const keywordsSet = [keywords, translatedKeywords]
    //   for (const each of keywordsSet) {
    //     // Generate a command or any string from keywords you want to pass to findPotentialBackLinks
    //     const originCommandFromKeywords = each.join(' '); // or any other logic
    //     let commandFromKeywords = this.preprocess(originCommandFromKeywords);
    //     commandFromKeywords = this.addSpacesToText(commandFromKeywords);
    //     // Call your findPotentialBackLinks with this command string and handle it as a promise
    //     const commandResult = await this.findPotentialBackLinks(commandFromKeywords, option);
    //     let lines = commandResult.split("\n");
    //     // Here you would filter lines or any other processing you originally did
    //     // ...
    //     lines = this.preprocessLines(lines, basename, aliases, existingLines);
    //     // Now update the UI
    //     this.updateUIWithLines(lines, backlink, 'Potential mentions: ' + originCommandFromKeywords, basename);
    //   }

    // });
  }


  // Helper function to highlight matches in a line
  private highlightMatches(line: string, indices: number[][]): string {
    let highlightedLine = '';
    let lastIndex = 0;

    indices.sort((a, b) => a[0] - b[0]); // Sort indices by start position

    for (let [start, end] of indices) {
      highlightedLine += line.slice(lastIndex, start);
      end = end + 1;
      highlightedLine += `<span class="highlight">${line.slice(start, end)}</span>`;
      lastIndex = end;
    }

    // Add the remaining part of the line after the last highlighted segment
    highlightedLine += line.slice(lastIndex);

    return highlightedLine;
  }

  async updateUIWithLines(searchMatches: SearchMatch[], backlink: any, type: string, filename: string) {
    // Find the unlinkedHeaderEl in the backlink object
    const unlinkedHeaderEl = backlink?.unlinkedHeaderEl as HTMLElement;
    const div = document.createElement("div");
    div.id = type + filename;
    if (unlinkedHeaderEl && unlinkedHeaderEl.parentElement) {
      // div.className = unlinkedHeaderEl.parentElement.className;
    }
    if (unlinkedHeaderEl) {
      // Check if a "potential mentions" section already exists
      const parentNode = unlinkedHeaderEl.parentNode;
      if (parentNode) {
        // Create a new section for "potential mentions"
        const section = document.createElement("div");
        section.id = type;
        section.textContent = type;
        // section.className = unlinkedHeaderEl.className;
        div.appendChild(section);
  
        const sectionForLines = document.createElement("div");
  
        // Process each line individually
        for (const item of searchMatches) {
          // Parse the line to extract the path, basename, and content
          const filePath = item.path;
          const content = item.line;
          const tfile: any = this.plugin.app.vault.getAbstractFileByPath(filePath);
          if (tfile == null) {
            continue;
          }
  
          // Create a new child element for the line
          const lineElement = document.createElement("div");
          // lineElement.className = unlinkedHeaderEl.className;

          // Create a separate element for the file path
          const filePathElement = document.createElement("span");
          filePathElement.className = "file-path";
          filePathElement.textContent = filePath;
          filePathElement.title = filePath; // Set the file path as the title attribute

          // Create a separate element for the content
          const contentElement = document.createElement("span");
          contentElement.className = "content";
          const highlightedContent = this.highlightMatches(content, item.indices);
          contentElement.innerHTML = highlightedContent;

          // Append both elements to the lineElement
          lineElement.appendChild(filePathElement);
                  // Add a line break for separation
        // const br = document.createElement("br");
        // lineElement.appendChild(br);
          lineElement.appendChild(contentElement);
  
          lineElement.addEventListener("click", async () => {
            const fileText: string = await this.plugin.app.vault.read(tfile);
            // Find start index of card
            const startIndex = fileText.search(this.escapeRegExp(content.trim()));
            if (startIndex != -1) {
              const n = {
                match: {
                  content: fileText,
                  matches: [[startIndex, startIndex + content.length]],
                },
              };
              this.plugin.app.workspace.openLinkText(tfile.basename, '/', true, {
                active: true,
                eState: n,
              });
              // openFileAndScrollToText(tfile.basename, line);
            } else {
              this.plugin.app.workspace.openLinkText(tfile.basename, '/', true, {
                active: true,
              });
            }
          });
  
          // Add the child element to the "potential mentions" section
          sectionForLines.appendChild(lineElement);
        }
  
        // Check if a "potential mentions" section already exists
        let existingIndex = -1;
        const existingSection = Array.from(parentNode.children).find((child: HTMLElement) => child.id === type);
        if (existingSection) {
          // Get the index
          existingIndex = Array.from(parentNode.children).indexOf(existingSection);
          parentNode.removeChild(existingSection);
        }
  
        // Add some space between the sections
        div.appendChild(sectionForLines);
  
        // Insert div to the index
        if (existingIndex != -1) {
          parentNode.insertBefore(div, parentNode.children[existingIndex]);
        } else {
          parentNode.appendChild(div);
        }
      }
    }
  }

  preprocessLines(lines: string[], basename: string, aliases: string[], existingLines: string[] = []): string[] {
    // Convert basename and aliases to lowercase for case-insensitive comparison
    const basenameLower = basename.toLowerCase();
    let aliasesLower: string[] = [];
    if (aliases) {
      aliasesLower = aliases.map(alias => alias.toLowerCase());
    }
    lines = lines.filter(line => {
      const lineLower = line.toLowerCase();
      // Check if line contains basename or any alias
      if (lineLower.includes(basenameLower) || (aliasesLower && aliasesLower.some(alias => lineLower.includes(alias)) || (existingLines && existingLines.some(t => lineLower.includes(t))))) {
        return false; // If it does, exclude it from the new array
      }
      return true; // If it doesn't, include it in the new array
    });
    return lines;
  }

  async patchComponent() {
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
      this.cancelTokenSource.cancel('Operation canceled due to active leaf change.');
      this.cancelTokenSource = axios.CancelToken.source();



      const activeEditor: any = this.plugin.app.workspace.activeEditor;
      const backlink = activeEditor?.backlinks;
      const file = this.plugin.app.workspace.getActiveFile();
      const basename = file?.basename ?? "";
      if (backlink != null) {

        // backlink.unlinkedCollapsed = false;
        if (backlink.unlinkedCollapsed == true) {
          backlink.unlinkedHeaderEl.click();
        }
        if (backlink.extraContext == false) {
          backlink.extraContextButtonEl.click();
        }

        const parentNode = backlink.unlinkedHeaderEl.parentNode;
        if ((undefined != Array.from(parentNode.children).find((child: HTMLElement) => child.id.startsWith('Potential mentions') && child.id.contains(basename)))) {
          return ;
        }
        let existingSection;
        while ((existingSection = Array.from(parentNode.children).find((child: HTMLElement) => child.id.startsWith('Potential mentions')))) {
          // get the index
          parentNode.removeChild(existingSection);
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


          let highlightsString = this.preprocess(basename);
          highlightsString = patcher.addSpacesToText(highlightsString);
          this.findPotentialBackLinks(highlightsString, options).then(result => {
            let lines = result;
          
            const aimFile: TFile | null | undefined = this.plugin.app.workspace.activeEditor?.file;
            let aliases: string[] = [];
            if (aimFile) {
              const metadataCache = app.metadataCache.getFileCache(aimFile);
              aliases = metadataCache?.frontmatter?.aliases || [];
            }
          
            if (aliases && aliases.length > 0) {
              this.getAliasLines(aliases, options).then(aliasLines => {
                lines = lines.concat(aliasLines);
                lines = Array.from(new Set(lines)); // Remove duplicates
          
                this.updateUIWithLines(lines, backlink, 'Potential mentions', basename);
              });
            } else {
              lines = Array.from(new Set(lines)); // Remove duplicates
          
              this.updateUIWithLines(lines, backlink, 'Potential mentions', basename);
            }
          });


        } catch (error) {
          if (!Platform.isMobile) {
            patcher.reportError(
              error,
              `Failed to execute grep and fzf command for file path: ${basename}`,
            );
          }
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
    // // Match Chinese characters and English words separately
    // const matches = text.match(/[\u4e00-\u9fff]|[\w']+/g);

    // if (matches) {
    //   // Add "'" before English words and spaces between Chinese characters and English words
    //   const processedMatches = matches.map(match => {
    //     // Check if the match is an English word by checking if it contains any ASCII characters
    //     if (/[A-Za-z0-9_]/.test(match)) {
    //       // If it's an English word, prepend it with "'"
    //       return "'" + match;
    //     } else {
    //       // If it's not an English word, return it as is
    //       return match;
    //     }
    //   });

    //   return processedMatches.join(' ');
    // } else {
    //   // If no matches, return the original text
    //   return text;
    // }
    return text;
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
