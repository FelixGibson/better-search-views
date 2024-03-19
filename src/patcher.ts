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
import axios from "axios";

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

async function associatedFromCoze(query: string): Promise<string> {
  try {
    const response = await axios.post('https://api.coze.com/open_api/v2/chat', {
      bot_id: "7347974486534356999",
      user: "29032201862555",
      query: query,
      stream: false
    }, {
      headers: {
        'Authorization': 'Bearer BkcTIVOBBDzNk6nstThfmzBsSZ836V0U0WCnWsJmGdYcm0PlQFozxzbcIcWYJuN2',
        'Content-Type': 'application/json',
        'Accept': '*/*'
      }
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

  constructor(private readonly plugin: BetterSearchViewsPlugin) { }

  escapeRegExp(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
  }

  preprocess(highlightsString: string) {
    const regex = /[^a-zA-Z0-9\s\u4e00-\u9fa5]/g;
    highlightsString = highlightsString.replace(regex, ' ');
    return highlightsString;
  }

  executeCommand(highlightsString: string, options: any) {
    return execSync(`grep --line-buffered --color=never -r "" * | fzf --filter="${highlightsString}"`, options).toString().trim();
  }

  getAliasLines(aliases: any, options: any) {
    const aliasLines = [];
    for (let alias of aliases) {
      alias = this.preprocess(alias);
      const aliasHighlightsString = this.addSpacesToText(alias);
      const aliasStdout = this.executeCommand(aliasHighlightsString, options);
      aliasLines.push(...aliasStdout.split("\n"));
    }
    return aliasLines;
  }
  // Call `associatedFromCoze`, use `executeCommand` with its result, update UI asynchronously
  useKeywordsAndUpdateUI(query: string, option: any, basename: string, aliases: string[], backlink: any, existingLines: string[]) {
    associatedFromCoze(query).catch(error => {
      this.reportError(
        error,
        "Error while query coze",
      );
      return "";
    }).then(response => {
      if (response == "") {
        return;
      }
      console.log("response is " + response);
      const jsonObject = JSON.parse(response);
      // Assuming response is already parsed JSON as your structure
      const keywords = jsonObject.iterations[0].keywords;
      const translatedKeywords = jsonObject.iterations[0].translatedKeywords;
      const keywordsSet = [keywords, translatedKeywords]
      for (const each of keywordsSet) {
        // Generate a command or any string from keywords you want to pass to executeCommand
        const originCommandFromKeywords = each.join(' '); // or any other logic
        let commandFromKeywords = this.preprocess(originCommandFromKeywords);
        commandFromKeywords = this.addSpacesToText(commandFromKeywords);
        // Call your executeCommand with this command string and handle it as a promise
        const commandResult = this.executeCommand(commandFromKeywords, option);
        let lines = commandResult.split("\n");
        // Here you would filter lines or any other processing you originally did
        // ...
        lines = this.preprocessLines(lines, basename, aliases, existingLines);
        // Now update the UI
        this.updateUIWithLines(lines, backlink, 'Potential mentions: ' + originCommandFromKeywords);
      }


      // const secondtranslatedKeywords = jsonObject.iterations[0].translatedKeywords;

      // // Generate a command or any string from keywords you want to pass to executeCommand
      // const second = secondtranslatedKeywords.join(' '); // or any other logic

      // // Call your executeCommand with this command string and handle it as a promise
      // const result = this.executeCommand(second, option);
      // let secondLines = result.split("\n");
      // // Here you would filter lines or any other processing you originally did
      // // ...
      // secondLines = this.preprocessLines(secondLines, basename, aliases, existingLines);
      // // Now update the UI
      // this.updateUIWithLines(secondLines, backlink, 'Translated Keywords mentions');


    });
  }

  updateUIWithLines(lines: string[], backlink: any, type: string) {
    // Find the unlinkedHeaderEl in the backlink object
    const unlinkedHeaderEl = backlink?.unlinkedHeaderEl as HTMLElement;
    const div = document.createElement("div");
    div.id = type;
    if (unlinkedHeaderEl) {
      // Check if a "potential mentions" section already exists
      const parentNode = unlinkedHeaderEl.parentNode;
      if (parentNode) {
        // Create a new section for "potential mentions"
        const section = document.createElement("div");
        section.id = type;
        section.textContent = type;
        section.className = unlinkedHeaderEl.className;
        div.appendChild(section);

        // Process each line individually
        for (const line of lines) {
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
          lineElement.className = unlinkedHeaderEl.className;
          lineElement.addEventListener("click", async () => {
            const fileText: string = await this.plugin.app.vault.read(tfile);
            //find start index of card
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
            }
            else {
              this.plugin.app.workspace.openLinkText(tfile.basename, '/', true, {
                active: true,
              });
            }
          });
          // Add the child element to the "potential mentions" section
          div.appendChild(lineElement);
        }
        // Check if a "potential mentions" section already exists
        const parentNode = unlinkedHeaderEl.parentNode;
        if (parentNode) {
          const existingSection = Array.from(parentNode.children).find((child: HTMLElement) => child.id === type);
          if (existingSection) {
            parentNode.removeChild(existingSection);
          }
        }
        parentNode.appendChild(div);
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


          let highlightsString = this.preprocess(basename);
          highlightsString = patcher.addSpacesToText(highlightsString);
          const stdout = this.executeCommand(highlightsString, options);
          let lines = stdout.split("\n");

          const aimFile: TFile | null | undefined = this.plugin.app.workspace.activeEditor?.file;
          let aliases: string[] = [];
          if (aimFile) {
            const metadataCache = app.metadataCache.getFileCache(aimFile);
            aliases = metadataCache?.frontmatter?.aliases;
            if (aliases && aliases.length > 0) {
              lines.push(...this.getAliasLines(aliases, options));
            }
          }

          this.useKeywordsAndUpdateUI(highlightsString, options, basename, aliases, backlink, lines);


          // // Usage example, catching error in usage as function is now async and may throw
          // associatedFromCoze(highlightsString).then((content) => {
          //   console.log(content); // "Hello! How can I assist you today?"
          // }).catch((error) => {
          //   console.log('An error occurred:', error.message);
          // });
          // call associatedFromCoze
          // const associatedSentenceResult = this.executeCommand(, options);


          // lines.push(...associatedSentenceResult.split("\n"));

          lines = Array.from(new Set(lines));
          lines = this.preprocessLines(lines, basename, aliases);

          this.updateUIWithLines(lines, backlink, 'Potential mentions');

          // // Find the unlinkedHeaderEl in the backlink object
          // const unlinkedHeaderEl = backlink?.unlinkedHeaderEl as HTMLElement;
          // if (unlinkedHeaderEl) {
          //   // Check if a "potential mentions" section already exists
          //   const parentNode = unlinkedHeaderEl.parentNode;
          //   if (parentNode) {
          //     const existingSection = Array.from(parentNode.children).find((child: HTMLElement) => child.id === 'potentialMentions');
          //     if (existingSection) {
          //       // If it does, remove it
          //       if (existingSection.parentNode) {
          //         existingSection.parentNode.removeChild(existingSection);
          //       }
          //     }
          //     const existingLines = Array.from(parentNode.children).filter((child: HTMLElement) => child.id === 'potentialMentionLine');
          //     for (const line of existingLines) {
          //       if (line.parentNode) {
          //         line.parentNode.removeChild(line);
          //       }
          //     }
          //     // Create a new section for "potential mentions"
          //     const potentialMentionsSection = document.createElement("div");
          //     potentialMentionsSection.id = 'potentialMentions';
          //     potentialMentionsSection.textContent = "Potential mentions";
          //     potentialMentionsSection.className = unlinkedHeaderEl.className;
          //     unlinkedHeaderEl.parentNode.appendChild(potentialMentionsSection);

          //     // Process each line individually
          //     for (const line of lines) {
          //       // Parse the line to extract the path, basename, and content
          //       const [filePath, content] = line.split(":");
          //       // const pathParts = filePath.split("/");
          //       // const basenameOfContent = pathParts[pathParts.length - 1];
          //       const tfile: any = this.plugin.app.vault.getAbstractFileByPath(filePath);
          //       if (tfile == null) {
          //         continue;
          //       }

          //       // Create a new child element for the line
          //       const lineElement = document.createElement("div");
          //       lineElement.textContent = line;
          //       lineElement.id = 'potentialMentionLine';
          //       lineElement.className = unlinkedHeaderEl.className;
          //       lineElement.addEventListener("click", async () => {
          //         const activeLeaf: WorkspaceLeaf = this.plugin.app.workspace.getLeaf();

          //         const fileText: string = await this.plugin.app.vault.read(tfile);
          //         //find start index of card
          //         const startIndex = fileText.search(this.escapeRegExp(content.trim()));
          //         if (startIndex != -1) {
          //             const n = {
          //                 match: {
          //                     content: fileText,
          //                     matches: [[startIndex, startIndex + content.length]],
          //                 },
          //             };
          //             // activeLeaf.openFile(tfile, {
          //             //     active: true,
          //             //     eState: n,
          //             // });
          //             this.plugin.app.workspace.openLinkText(tfile.basename, '/', true, {
          //               active: true,
          //               eState: n,
          //             });
          //             // openFileAndScrollToText(tfile.basename, line);
          //         } 
          //         else {
          //           this.plugin.app.workspace.openLinkText(tfile.basename, '/', true, {
          //             active: true,
          //           });
          //           // await activeLeaf.openFile(tfile);
          //           // const activeView: MarkdownView =
          //           //     this.app.workspace.getActiveViewOfType(MarkdownView);
          //           // activeView.editor.setCursor({
          //           //     line: this.currentCard.lineNo,
          //           //     ch: 0,
          //           // });
          //           // activeView.editor.scrollTo(this.currentCard.lineNo, 0);
          //       }
          //     });
          //       // Add the child element to the "potential mentions" section
          //       unlinkedHeaderEl.parentNode.appendChild(lineElement);
          //     }

          //   }
          // }

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
