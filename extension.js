const vscode = require('vscode');
const path = require('path');
const fs = require("fs");

const extensionId = 'mblet.html-navigate-preview';
const extensionIdNormalize = extensionId.replace(/[.-]/g, '_');
let log = undefined;
let activeWebViewPannel = undefined;

const fixRegexes = [
    /(<link\s[^]*?(?!>)(?:href\s*=\s*['"]))((?!http|\/).*?)(['"][^>]*[>])/gmi,
    /(<(?:script|img|input)\s[^]*?(?!>)(?:src\s*=\s*['"]))((?!http|\/).*?)(['"][^>]*[>])/gmi,
];

class Previewer {
    constructor(context) {
        this.context = context;
        this.webviewPannel = undefined;
        this.localResourceRoots = [];
        this.html = "";
        this.refhtml = undefined;
        this.uri = undefined;
        this.index = 0;
        this.uris = [];
        this.timerSync = undefined;
        this.navBarActive = true;
    }

    createWebview() {
        log.info(`Create webview`);
        this.webviewPannel = vscode.window.createWebviewPanel(
            'html.navigate.preview',
            'HTML navigate preview',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                enableFindWidget: true,
                enableCommandUris: true,
                retainContextWhenHidden: true
            }
        );
        this.webviewPannel.onDidDispose(
            async ()=>{
                log.info(`Dispose webview`);
                this.webviewPannel = undefined;
                this.uris = [];
                await this.disableSync();
            },
            this,
            this.context.subscriptions
        );
        this.webviewPannel.webview.onDidReceiveMessage(
            async (message) => {
                log.info(message);
                switch (message.command) {
                    case 'addLocalResourceFromUri':
                        const webviewUri = this.addUriOnLocalRessourceRoots(message.data.uri);
                        this.webviewPannel.webview.postMessage({
                            command: 'addResolveLink',
                            data: {
                                src: message.data.src,
                                resolve: `${webviewUri}`
                            }
                        });
                        break;
                    case 'alert':
                        vscode.window.showWarningMessage(message.data, 'Close').then(e => {});
                        break;
                    case 'sync':
                        this.activeSync();
                        break;
                    case 'unsync':
                        this.disableSync();
                        break;
                    case 'refresh':
                        await this.refresh();
                        break;
                    case 'prev':
                        this.prev();
                        break;
                    case 'next':
                        this.next();
                        break;
                    case 'reference':
                        vscode.workspace.openTextDocument(this.uri).then(doc => {
                            vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                        });
                        break;
                    case 'uriTo':
                        let uriStr = 'file://';
                        uriStr += message.data.path;
                        if (message.query !== undefined) {
                            uriStr += `?${message.query}`;
                        }
                        if (message.fragment !== undefined) {
                            uriStr += `#${message.fragment}`;
                        }
                        this.load(vscode.Uri.parse(uriStr), true);
                        break;
                    case 'historyIndexTo':
                        // get index of uri
                        this.index = parseInt(message.data);
                        this.load(vscode.Uri.parse(this.uris[this.index]));
                        break;
                }
            },
            this,
            this.context.subscriptions
        );
        this.webviewPannel.onDidChangeViewState(
            ()=>{
                log.info(`onDidChangeViewState`);
                if (this.webviewPannel && this.webviewPannel.active && this.webviewPannel.visible) {
                    vscode.commands.executeCommand(`setContext`, `webview.active`, true);
                } else {
                    vscode.commands.executeCommand(`setContext`, `webview.active`, false);
                }
            },
            this,
            this.context.subscriptions
        );
        if (vscode.workspace.getConfiguration("html-navigate-preview").get('startup-synchronized')) {
            this.activeSync();
        }
    }

    addFilepathOnLocalRessourceRoots(filepath) {
        const localpath = path.join(path.dirname(this.uri.fsPath), filepath);
        const dirUri = path.dirname(localpath);
        if (!this.localResourceRoots.includes(dirUri)) {
            this.localResourceRoots.push(dirUri);
            // log.info(`Length of localroots: ${this.localResourceRoots.length}`);
            this.webviewPannel.webview.options = {
                enableScripts: true,
                enableCommandUris: true,
                localResourceRoots: this.localResourceRoots.map((e)=>{return vscode.Uri.file(e);})
            };
            // for (let i = 0; i < this.localResourceRoots.length; i++) {
            //     log.info(`- ${this.localResourceRoots[i]}`);
            // }
        }
        let webViewUri = this.webviewPannel.webview.asWebviewUri(vscode.Uri.file(localpath));
        return webViewUri;
    }

    addUriOnLocalRessourceRoots(uri) {
        let localpath = path.dirname(this.uri.fsPath) + uri.path;
        let j = 1;
        while (!fs.existsSync(localpath)) {
            localpath = path.dirname(this.uri.fsPath) + '/..'.repeat(j) + uri.path;
            j++;
            if (j > 5) {
                return uri;
            }
        }
        localpath = path.join(localpath);
        let dirUri = path.dirname(localpath);
        if (!this.localResourceRoots.includes(dirUri)) {
            this.localResourceRoots.push(dirUri);
            // log.info(`Length of localroots: ${this.localResourceRoots.length}`);
            this.webviewPannel.webview.options = {
                enableScripts: true,
                enableCommandUris: true,
                localResourceRoots: this.localResourceRoots.map((e)=>{return vscode.Uri.file(e);})
            };
            // for (let i = 0; i < this.localResourceRoots.length; i++) {
            //     log.info(`- ${this.localResourceRoots[i]}`);
            // }
        }
        let uriPath = 'file://' + localpath;
        if (uri.query !== undefined) {
            uriPath += `?${uri.query}`;
        }
        if (uri.fragment !== undefined) {
            uriPath += `#${uri.fragment}`;
        }
        let webViewUri = this.webviewPannel.webview.asWebviewUri(vscode.Uri.parse(uriPath));
        return webViewUri;
    }

    fixLinks() {
        const self = this;
        for (let i = 0; i < fixRegexes.length; i++) {
            this.html = this.html.replace(fixRegexes[i], (_, p1, p2, p3) => {
                return p1 + self.addFilepathOnLocalRessourceRoots(p2) + p3;
            });
        }
    }

    addConfigurationStyle() {
        const css = vscode.workspace.getConfiguration("html-navigate-preview").css;
        let styleStr = "";
        for (const key in css) {
            if (css.hasOwnProperty(key)) {
                styleStr += `${key}{`;
                for (const itemKey in css[key]) {
                    if (css[key].hasOwnProperty(itemKey)) {
                        styleStr += `${itemKey}:${css[key][itemKey]};`;
                    }
                }
                styleStr += `}\n`;
            }
        }
        this.html = `
            <style>
                ${styleStr}
                #${extensionIdNormalize}_nav_body {
                    display: flex;
                    gap: 2px;
                    z-index: 16777271;
                    border-radius: 0 0 4px 0;
                    position: fixed;
                    top: 0px;
                    left: 0px;
                    background-color: var(--vscode-panel-background);
                    padding: 0px;
                    color: var(--vscode-icon-foreground);
                    height: 22px;
                    width: auto;
                    -webkit-touch-callout: none;
                    -webkit-user-select: none;
                    -khtml-user-select: none;
                    -moz-user-select: none;
                    -ms-user-select: none;
                    user-select: none;
                }
                #${extensionIdNormalize}_nav_body .icon_button {
                    display: inline-block;
                    height: 22px;
                    width: 22px;
                    border-radius: 4px;
                    cursor: pointer;
                }
                #${extensionIdNormalize}_nav_body .icon_button:hover {
                    background-color: var(--vscode-toolbar-hoverBackground);
                }
                #${extensionIdNormalize}_nav_body .icon_button svg {
                    margin: 3px;
                    width: 16px;
                    height: 16px;
                }
                #${extensionIdNormalize}_nav_body .icon_button svg path {
                    filter: drop-shadow(0 0 0.5px var(--vscode-icon-foreground));
                }
                #${extensionIdNormalize}_nav_body .icon_button_disabled {
                    display: inline-block;
                    height: 22px;
                    width: 22px;
                    border-radius: 4px;
                    cursor: pointer;
                    color: var(--vscode-disabledForeground);
                }
                #${extensionIdNormalize}_nav_body .icon_button_disabled svg {
                    margin: 3px;
                    width: 16px;
                    height: 16px;
                }
                #${extensionIdNormalize}_nav_body .icon_button_disabled svg path {
                    filter: drop-shadow(0 0 0.5px var(--vscode-disabledForeground));
                }
                #${extensionIdNormalize}_nav_body [data-tooltip]:hover::after {
                    display: block;
                    position: absolute;
                    content: attr(data-tooltip);
                    border-radius: 4px;
                    background-color: var(--vscode-panel-background);
                    color: var(--vscode-icon-foreground);
                    padding: .25em;
                }
                #${extensionIdNormalize}_nav_body .uri_path {
                    display: inline-block;
                    height: 22px;
                }
                #${extensionIdNormalize}_nav_body select {
                    display: inline-block;
                    color: var(--vscode-input-foreground);
                    background-color: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                    height: 20px;
                    max-width: 200px;
                }
                #${extensionIdNormalize}_nav_body select:focus {
                    outline: none;
                    border: 1px solid var(--vscode-settings-focusedRowBorder);
                }
                #${extensionIdNormalize}_nav_body input {
                    overflow: hidden;
                    white-space: nowrap;
                    display: inline-block;
                    width: auto;
                    line-height: 18px;
                    height: 18px;
                    margin: 0 2px 0 0;
                    padding: 0;
                    color: var(--vscode-input-foreground);
                    background-color: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    resize: none;
                }
                #${extensionIdNormalize}_nav_body input:focus {
                    outline: none;
                    border: 1px solid var(--vscode-settings-focusedRowBorder);
                }
                #${extensionIdNormalize}_nav_body .hidden {
                    display: none;
                }
            </style>
            ${this.html}
        `;
    }

    addNavBar() {
        let prevClass = 'icon_button';
        let nextClass = 'icon_button';

        // active prev and next buttons
        if (this.index == 0) {
            prevClass = 'icon_button_disabled';
        }
        if (this.index == this.uris.length - 1) {
            nextClass = 'icon_button_disabled';
        }
        let nav = `
            <div id="${extensionIdNormalize}_nav_body">
                <div id="${extensionIdNormalize}_nav_sync" data-tooltip="Synchronize" class="icon_button"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path shape-rendering="auto" fill-rule="evenodd" clip-rule="evenodd" d="M2.006 8.267L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.76.76-1.167-1.18a5 5 0 0 0 9.4 1.983l.813.597a6 6 0 0 1-11.22-2.683zm10.99-.466L11.76 6.55l-.76.76 2.09 2.11.76.01 2.09-2.07-.75-.76-1.194 1.18a6 6 0 0 0-11.11-2.92l.81.594a5 5 0 0 1 9.3 2.346z"/></svg></div>
                <div id="${extensionIdNormalize}_nav_unsync" data-tooltip="Unsynchronize" class="icon_button hidden"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path shape-rendering="auto" fill-rule="evenodd" clip-rule="evenodd" d="M5.468 3.687l-.757-.706a6 6 0 0 1 9.285 4.799L15.19 6.6l.75.76-2.09 2.07-.76-.01L11 7.31l.76-.76 1.236 1.25a5 5 0 0 0-7.528-4.113zm4.55 8.889l.784.73a6 6 0 0 1-8.796-5.04L.78 9.5 0 8.73l2.09-2.07.76.01 2.09 2.12-.76.76-1.167-1.18a5 5 0 0 0 7.005 4.206z"/><path d="M1.123 2.949l.682-.732L13.72 13.328l-.682.732z"/></svg></div>
                <div id="${extensionIdNormalize}_nav_refresh" data-tooltip="Refresh" class="icon_button"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path shape-rendering="auto" fill-rule="evenodd" clip-rule="evenodd" d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z"/></svg></div>
                <div id="${extensionIdNormalize}_nav_prev" data-tooltip="Prev" class="${prevClass}"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path shape-rendering="auto" fill-rule="evenodd" clip-rule="evenodd" d="M5.928 7.976l4.357 4.357-.618.62L5 8.284v-.618L9.667 3l.618.619-4.357 4.357z"/></svg></div>
                <div id="${extensionIdNormalize}_nav_next" data-tooltip="Next" class="${nextClass}"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path shape-rendering="auto" fill-rule="evenodd" clip-rule="evenodd" d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"/></svg></div>
                <select id="${extensionIdNormalize}_nav_select"></select>
                <div id="${extensionIdNormalize}_nav_reference" data-tooltip="Reference" class="icon_button"><svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path shape-rendering="auto" fill-rule="evenodd" clip-rule="evenodd" d="M11.105 4.561l-3.43 3.427-1.134-1.12 2.07-2.08h-4.8a2.4 2.4 0 1 0 0 4.8h.89v1.6h-.88a4 4 0 0 1 0-7.991h4.8L6.54 1.13 7.675 0l3.43 3.432v1.13zM16.62 24h-9.6l-.8-.8V10.412l.8-.8h9.6l.8.8V23.2l-.8.8zm-8.8-1.6h8V11.212h-8V22.4zm5.6-20.798h9.6l.8.8v12.786l-.8.8h-4v-1.6h3.2V3.2h-8v4.787h-1.6V2.401l.8-.8zm.8 11.186h-4.8v1.6h4.8v-1.6zm-4.8 3.2h4.8v1.6h-4.8v-1.6zm4.8 3.2h-4.8v1.6h4.8v-1.6zm1.6-14.4h4.8v1.6h-4.8v-1.6zm4.8 6.4h-1.6v1.6h1.6v-1.6zm-3.338-3.176v-.024h3.338v1.6h-1.762l-1.576-1.576z"/></svg></div>
            </div>
        `;
        this.html = `
            ${nav}
            ${this.html}
        `;
    }

    addApiScript() {
        let api = `
            const vscode = acquireVsCodeApi();
            const _regexp = /^(([^:/?#]+?):)?(\\/\\/([^/?#]*))?([^?#]*)(\\?([^#]*))?(#(.*))?/;
            let ${extensionIdNormalize}_localLinkMap = [];

            function ${extensionIdNormalize}_createUri(path, query, fragment) {
                return {
                    $mid: 1,
                    path: path,
                    query: query,
                    fragment: fragment
                };
            }

            function ${extensionIdNormalize}_fixIframes(link_items) {
                for (let i = 0; i < link_items.length; i++) {
                    link_items[i].outerHTML = link_items[i].outerHTML.replace('iframe', 'code');
                }
            }

            function ${extensionIdNormalize}_redirectLinks(link_items) {
                for (let i = 0; i < link_items.length; i++) {
                    if (!link_items[i].href.startsWith('command:') && link_items[i].href.startsWith('vscode-webview://')) {
                        const match = _regexp.exec(link_items[i].href);
                        if (match) {
                            if (match[7]?.includes('&extensionId=${extensionId}')) {
                                link_items[i].href = 'command:html.preview.file?' + encodeURIComponent(JSON.stringify(${extensionIdNormalize}_createUri('${path.join(this.uri.fsPath)}', match[7], match[9])));
                            }
                            else {
                                link_items[i].href = 'command:html.preview.file?' + encodeURIComponent(JSON.stringify(${extensionIdNormalize}_createUri('${path.dirname(this.uri.fsPath)}' + match[5], match[7], match[9])));
                            }
                        }
                    }
                }
            }

            function ${extensionIdNormalize}_redirectLinksWithOnClick(link_items) {
                for (let i = 0; i < link_items.length; i++) {
                    if (!link_items[i].href.startsWith('command:') && link_items[i].href.startsWith('vscode-webview://')) {
                        const match = _regexp.exec(link_items[i].href);
                        if (match) {
                            if (match[7]?.includes('&extensionId=${extensionId}')) {
                                link_items[i].href = 'command:html.preview.file?' + encodeURIComponent(JSON.stringify(${extensionIdNormalize}_createUri('${path.join(this.uri.fsPath)}', match[7], match[9])));
                                link_items[i].onclick = function() {
                                    vscode.postMessage({
                                        command: 'uriTo',
                                        data: ${extensionIdNormalize}_createUri('${path.join(this.uri.fsPath)}', match[7], match[9])
                                    });
                                }
                            }
                            else {
                                link_items[i].href = 'command:html.preview.file?' + encodeURIComponent(JSON.stringify(${extensionIdNormalize}_createUri('${path.dirname(this.uri.fsPath)}' + match[5], match[7], match[9])));
                                link_items[i].onclick = function() {
                                    vscode.postMessage({
                                        command: 'uriTo',
                                        data: ${extensionIdNormalize}_createUri('${path.dirname(this.uri.fsPath)}' + match[5], match[7], match[9])
                                    });
                                }
                            }
                        }
                    }
                }
            }

            function ${extensionIdNormalize}_fixLinks(link_items) {
                for (let i = 0; i < link_items.length; i++) {
                    if (link_items[i].src.startsWith('vscode-webview://')) {
                        if (link_items[i].src in ${extensionIdNormalize}_localLinkMap) {
                            // replace source from map
                            link_items[i].src = ${extensionIdNormalize}_localLinkMap[link_items[i].src];
                        }
                        else {
                            // send to vscode a resolve link
                            const match = _regexp.exec(link_items[i].src);
                            if (match) {
                                let uri = ${extensionIdNormalize}_createUri(match[5], match[7], match[9]);
                                vscode.postMessage({
                                    command: 'addLocalResourceFromUri',
                                    data: {
                                        src: link_items[i].src,
                                        uri: uri
                                    }
                                });
                            }
                        }
                    }
                }
            }

            // ${extensionIdNormalize}_fixIframes(document.getElementsByTagName('iframe'));
            ${extensionIdNormalize}_redirectLinks(document.getElementsByTagName('a'));
            ${extensionIdNormalize}_redirectLinksWithOnClick(document.getElementsByTagName('area'));
            ${extensionIdNormalize}_fixLinks(document.getElementsByTagName('img'));
            ${extensionIdNormalize}_fixLinks(document.getElementsByTagName('input'));
            setInterval(() => {
                // ${extensionIdNormalize}_fixIframes(document.getElementsByTagName('iframe'));
                ${extensionIdNormalize}_redirectLinks(document.getElementsByTagName('a'));
                ${extensionIdNormalize}_redirectLinksWithOnClick(document.getElementsByTagName('area'));
                ${extensionIdNormalize}_fixLinks(document.getElementsByTagName('img'));
                ${extensionIdNormalize}_fixLinks(document.getElementsByTagName('input'));
            }, 100);

            function ${extensionIdNormalize}_update_sync(state) {
                if (state) {
                    document.getElementById('${extensionIdNormalize}_nav_sync').classList.add("hidden");
                    document.getElementById('${extensionIdNormalize}_nav_unsync').classList.remove("hidden");
                }
                else {
                    document.getElementById('${extensionIdNormalize}_nav_sync').classList.remove("hidden");
                    document.getElementById('${extensionIdNormalize}_nav_unsync').classList.add("hidden");
                }
            }
            function ${extensionIdNormalize}_hide_nav_bar(state) {
                if (state) {
                    document.getElementById('${extensionIdNormalize}_nav_body').style.display = 'none';
                }
                else {
                    document.getElementById('${extensionIdNormalize}_nav_body').style.display = 'flex';
                }
            }

            // Handle messages sent from the extension
            window.addEventListener('message', event => {
                // console.log(event);
                const message = event.data; // The JSON data our extension sent
                switch (message.command) {
                    case 'addResolveLink':
                        ${extensionIdNormalize}_localLinkMap[message.data.src] = message.data.resolve;
                        break;
                    case 'updateSync':
                        ${extensionIdNormalize}_update_sync(message.data);
                        break;
                    case 'hideNavBar':
                        ${extensionIdNormalize}_hide_nav_bar(message.data);
                        break;
                    case 'scrollTop':
                        window.scrollTo({top: 0});
                        break;
                }
            });

            function alert(msg) {
                vscode.postMessage({
                    command: 'alert',
                    data: msg
                });
            }

            // applicate onclick event on nav_bar
            document.getElementById('${extensionIdNormalize}_nav_sync').onclick      = function() {vscode.postMessage({command: 'sync'});}
            document.getElementById('${extensionIdNormalize}_nav_unsync').onclick    = function() {vscode.postMessage({command: 'unsync'});}
            document.getElementById('${extensionIdNormalize}_nav_refresh').onclick   = function() {vscode.postMessage({command: 'refresh'});}
            document.getElementById('${extensionIdNormalize}_nav_prev').onclick      = function() {vscode.postMessage({command: 'prev'});}
            document.getElementById('${extensionIdNormalize}_nav_next').onclick      = function() {vscode.postMessage({command: 'next'});}
            document.getElementById('${extensionIdNormalize}_nav_reference').onclick = function() {vscode.postMessage({command: 'reference'});}
        `;
        if (this.uris.length > 0) {
            api += `
                function ${extensionIdNormalize}_select() {
                    vscode.postMessage({
                        command: 'historyIndexTo',
                        data: document.getElementById('${extensionIdNormalize}_nav_select').value
                    });
                }

                // applicate onchange event of the select on nav_bar
                document.getElementById('${extensionIdNormalize}_nav_select').onchange   = ${extensionIdNormalize}_select;

                // build options of the select on nav_bar
                document.getElementById('${extensionIdNormalize}_nav_select').innerHTML  = \`
            `;
            for (let i = 0; i < this.uris.length; i++) {
                const uri = vscode.Uri.parse(this.uris[i]);
                let transfromUri = path.basename(uri.fsPath);
                if (uri.fragment !== undefined && uri.fragment != null && uri.fragment != "")
                transfromUri += "#" + uri.fragment;
                api += `
                    <option value="${i}">${transfromUri}</option>
                `;
            }
            api += `
                \`;

                // applicate current value of the select on nav_bar
                document.getElementById('${extensionIdNormalize}_nav_select').value     = "${this.index}";
            `;
        }
        if (this.timerSync) {
            api += `
                ${extensionIdNormalize}_update_sync(true);
            `;
        }
        else {
            api += `
                ${extensionIdNormalize}_update_sync(false);
            `;
        }
        if (this.navBarActive == false) {
            api += `
                ${extensionIdNormalize}_hide_nav_bar(true);
            `;
        }
        if (this.uri.fragment !== undefined && this.uri.fragment != null && this.uri.fragment != "") {
            api += `
                window.addEventListener('load', function() {
                    const el = document.getElementById('${this.uri.fragment}');
                    const y = el?.getBoundingClientRect().top + window.pageYOffset;
                    if (y !== undefined) {
                        window.scrollTo({top: y});
                    }
                });
            `;
        }
        // else {
        //     api += `
        //         window.scrollTo({top: 0});
        //     `;
        // }

        this.html = `
            <script>${api}</script>
            ${this.html}
        `;
    }

    async load(uri, addToList = false) {
        if (addToList) {
            if (this.uris.length == 0 || (this.uris.length > 0 && this.uris[this.uris.length - 1] != uri.toString(true))) {
                this.uris.push(uri.toString(true));
            }
            this.index = this.uris.length - 1;
        }
        // create webview
        try {
            if (this.webviewPannel == undefined || this.webviewPannel.webview == undefined) {
                this.createWebview();
            }
            this.webviewPannel.webview.postMessage({
                command: 'scrollTop'
            });
        }
        catch (error) {
            this.createWebview();
        }
        // active prev and next buttons
        if (this.index == 0) {
            vscode.commands.executeCommand(`setContext`, `html.preview.prev.active`, false);
        }
        else {
            vscode.commands.executeCommand(`setContext`, `html.preview.prev.active`, true);
        }
        if (this.index == this.uris.length - 1) {
            vscode.commands.executeCommand(`setContext`, `html.preview.next.active`, false);
        }
        else {
            vscode.commands.executeCommand(`setContext`, `html.preview.next.active`, true);
        }
        // get uri
        this.uri = uri;
        // reset localResourceRoots
        this.localResourceRoots = [];
        // get file content from uri
        this.html = '';
        // add default styles
        this.addConfigurationStyle();
        // add api script
        this.addApiScript();
        // add navbar
        this.addNavBar();
        // load file
        if (vscode.window.activeTextEditor?.document?.uri?.toString(true) == this.uri.toString(true)) {
            this.refhtml = `${vscode.window.activeTextEditor.document.getText()}`;
        }
        else {
            this.refhtml = `${await vscode.workspace.fs.readFile(this.uri)}`;
        }
        this.html = `${this.refhtml}${this.html}`;
        // fix links
        this.fixLinks();
        // update html
        this.webviewPannel.webview.html = `${this.html}`;
        // set title
        this.webviewPannel.title = `${path.basename(this.uri.fsPath)} - HTML preview`;
    }

    async activeSync() {
        const self = this;
        if (this.timerSync) {
            clearInterval(this.timerSync);
            this.timerSync = undefined;
        }
        this.timerSync = setInterval(async () => {
            await self.sync();
        }, vscode.workspace.getConfiguration("html-navigate-preview").delay);
        if (this.webviewPannel !== undefined) {
                await this.webviewPannel.webview.postMessage({
                command: 'updateSync',
                data: true
            });
        }
        await vscode.commands.executeCommand(`setContext`, `html.preview.sync.active`, true);
    }

    async disableSync() {
        if (this.timerSync) {
            clearInterval(this.timerSync);
            this.timerSync = undefined;
        }
        if (this.webviewPannel !== undefined) {
            await this.webviewPannel.webview.postMessage({
                command: 'updateSync',
                data: false
            });
        }
        await vscode.commands.executeCommand(`setContext`, `html.preview.sync.active`, false);
    }

    async sync() {
        try {
            if (vscode.window.activeTextEditor?.document?.uri?.toString(true) == this.uri?.toString(true)) {
                // get text from file
                let refhtml = vscode.window.activeTextEditor.document.getText();
                if (refhtml != this.refhtml) {
                    log.info('reload from content');
                    await this.load(this.uri);
                }
            }
            else {
                // load file
                let refhtml = await vscode.workspace.fs.readFile(this.uri);
                if (refhtml != this.refhtml) {
                    log.info('reload from file');
                    await this.load(this.uri);
                }
            }
        }
        catch (error) {

        }
    }

    async refresh() {
        try {
            log.info("refresh");
            await this.load(vscode.Uri.parse(this.uris[this.index]));
        }
        catch (error) {
            log.error(error.toString());
        }
    }

    async prev() {
        try {
            if (this.index != 0) {
                this.index--;
                await this.load(vscode.Uri.parse(this.uris[this.index]));
            }
        }
        catch (error) {
            log.error(error.toString());
        }
    }

    async next() {
        try {
            if (this.index != this.uris.length - 1) {
                this.index++;
                await this.load(vscode.Uri.parse(this.uris[this.index]));
            }
        }
        catch (error) {
            log.error(error.toString());
        }
    }

    async showNavBar() {
        if (this.webviewPannel !== undefined) {
            await this.webviewPannel.webview.postMessage({
                command: 'hideNavBar',
                data: false
            });
        }
        this.navBarActive = true;
        await vscode.commands.executeCommand(`setContext`, `html.preview.nav.active`, true);
    }

    async hideNavBar() {
        if (this.webviewPannel !== undefined) {
            await this.webviewPannel.webview.postMessage({
                command: 'hideNavBar',
                data: true
            });
        }
        this.navBarActive = false;
        await vscode.commands.executeCommand(`setContext`, `html.preview.nav.active`, false);
    }
} // Previewer

function activate(context) {
    // initialize global log
    log = vscode.window.createOutputChannel('html preview', { log: true });
    const previewer = new Previewer(context);
    // reset context
    vscode.commands.executeCommand(`setContext`, `html.preview.prev.active`, false);
    vscode.commands.executeCommand(`setContext`, `html.preview.next.active`, false);
    vscode.commands.executeCommand(`setContext`, `html.preview.nav.active`, true);

    context.subscriptions.push(
        vscode.commands.registerCommand('html.preview.file', async (uri) => {
            // force file scheme
            uri.scheme = 'file';
            log.info(`Command html.preview.file: '${JSON.stringify(uri)}'`);
            await previewer.load(uri, true);
        }),
        vscode.commands.registerCommand('html.preview.folder', async (uri) => {
            log.info(`Command html.preview.folder: '${JSON.stringify(uri)}'`);
            const indexHtmlUri = vscode.Uri.file(path.join(uri.fsPath, 'index.html'));
            try {
                await vscode.workspace.fs.stat(indexHtmlUri);
                await previewer.load(indexHtmlUri, true);
            } catch {
                const indexHtmUri = vscode.Uri.file(path.join(uri.fsPath, 'index.htm'));
                try {
                    await vscode.workspace.fs.stat(indexHtmUri);
                    await previewer.load(indexHtmUri, true);
                } catch {
                    log.error(`index.htm or index.html not found on '${JSON.stringify(uri)}'`);
                }
            }
        }),
        vscode.commands.registerCommand('html.preview.refresh', async () => {
            log.info(`Command html.preview.refresh`);
            await previewer.refresh();
        }),
        vscode.commands.registerCommand('html.preview.prev', async () => {
            log.info(`Command html.preview.prev`);
            await previewer.prev();
        }),
        vscode.commands.registerCommand('html.preview.next', async () => {
            log.info(`Command html.preview.next`);
            await previewer.next();
        }),
        vscode.commands.registerCommand('html.preview.sync', async () => {
            log.info(`Command html.preview.sync`);
            await previewer.activeSync();
        }),
        vscode.commands.registerCommand('html.preview.unsync', async () => {
            log.info(`Command html.preview.unsync`);
            await previewer.disableSync();
        }),
        vscode.commands.registerCommand('html.preview.nav.show', async () => {
            log.info(`Command html.preview.nav.show`);
            await previewer.showNavBar();
        }),
        vscode.commands.registerCommand('html.preview.nav.hide', async () => {
            log.info(`Command html.preview.nav.hide`);
            await previewer.hideNavBar();
        }),
        vscode.commands.registerCommand('html.preview.reference', async () => {
            log.info(`Command html.preview.reference`);
            await vscode.workspace.openTextDocument(previewer.uri).then(doc => {
                vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            });
        })
    );
}

function desactivate() {}

module.exports = { activate, desactivate }