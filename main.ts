import {
	App,
	ButtonComponent,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	normalizePath,
	DataAdapter,
} from "obsidian";

const baseURL = process.env.COOKSYNC_SERVER_URL || "http://localhost:3000";

interface AuthResponse {
	token: string;
}

interface ExportRequestResponse {
	latest_id: number;
	status: string;
}

// interface ExportStatusResponse {
// 	totalBooks: number,
// 	booksExported: number,
// 	isFinished: boolean,
// 	taskStatus: string,
// }

interface CooksyncSettings {
	token: string;
	cooksyncDir: string;
	isSyncing: boolean;
	triggerOnLoad: boolean;
	lastSyncFailed: boolean;
	lastSyncTime?: number;
	recipeIDs: number[];
	// lastSavedStatusID: number;
	// currentSyncStatusID: number;
}

const DEFAULT_SETTINGS: CooksyncSettings = {
	token: "",
	cooksyncDir: "Cooksync",
	isSyncing: false,
	triggerOnLoad: true,
	lastSyncFailed: false,
	lastSyncTime: undefined,
	recipeIDs: [],
};

export default class Cooksync extends Plugin {
	settings: CooksyncSettings;
	fs: DataAdapter;

	async onload() {
		await this.loadSettings();

		// Do not do this too often
		//this.startSync();

		// This creates an icon in the left ribbon.
		// const ribbonIconEl = this.addRibbonIcon(
		// 	"dice",
		// 	"Sample Plugin",
		// 	(evt: MouseEvent) => {
		// 		// Called when the user clicks the icon.
		// 		new Notice("This is a notice!");
		// 	}
		// );
		// // Perform additional things with the ribbon
		// ribbonIconEl.addClass("my-plugin-ribbon-class");

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		// const statusBarItemEl = this.addStatusBarItem();
		// statusBarItemEl.setText("Status Bar Text");

		// This adds a simple command that can be triggered anywhere
		// this.addCommand({
		// 	id: "open-sample-modal-simple",
		// 	name: "Open sample modal (simple)",
		// 	callback: () => {
		// 		new SampleModal(this.app).open();
		// 	},
		// });
		// This adds an editor command that can perform some operation on the current editor instance
		// this.addCommand({
		// 	id: "sample-editor-command",
		// 	name: "Sample editor command",
		// 	editorCallback: (editor: Editor, view: MarkdownView) => {
		// 		console.log(editor.getSelection());
		// 		editor.replaceSelection("Sample Editor Command");
		// 	},
		// });
		// // This adds a complex command that can check whether the current state of the app allows execution of the command
		// this.addCommand({
		// 	id: "open-sample-modal-complex",
		// 	name: "Open sample modal (complex)",
		// 	checkCallback: (checking: boolean) => {
		// 		// Conditions to check
		// 		const markdownView =
		// 			this.app.workspace.getActiveViewOfType(MarkdownView);
		// 		if (markdownView) {
		// 			// If checking is true, we're simply "checking" if the command can be run.
		// 			// If checking is false, then we want to actually perform the operation.
		// 			if (!checking) {
		// 				new SampleModal(this.app).open();
		// 			}

		// 			// This command will only show up in Command Palette when the check function returns true
		// 			return true;
		// 		}
		// 	},
		// });

		if (
			this.settings.triggerOnLoad &&
			(!this.settings.lastSyncTime ||
				this.settings.lastSyncTime < Date.now() - 1000 * 60 * 60 * 2)
		) {
			this.startSync();
		}

		this.addCommand({
			id: "cooksync-sync",
			name: "Sync your data",
			callback: () => {
				this.startSync();
			},
		});

		//TODO: add a command to resync recipe

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new CooksyncSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, "click", (evt: MouseEvent) => {
		// 	console.log("click", evt);
		// });

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(
			window.setInterval(() => console.log("setInterval"), 5 * 60 * 1000)
		);
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getAuthHeaders() {
		return {
			Authorization: `Bearer ${this.settings.token}`,
			"Obsidian-Client": `${this.getObsidianClientID()}`,
		};
	}

	// clearSettingsAfterRun() {
	// 	this.settings.isSyncing = false;
	// 	//this.settings.currentSyncStatusID = 0;
	// }

	getErrorMessageFromResponse(response?: Response) {
		if (response && response.status === 409) {
			return "Sync in progress initiated by different client";
		}
		if (response && response.status === 417) {
			return "Obsidian export is locked. Wait for an hour.";
		}
		return `${response ? response.statusText : "Can't connect to server"}`;
	}

	handleSyncSuccess(
		buttonContext?: ButtonComponent,
		msg: string = "Synced",
		exportID: number | null = null
	) {
		this.settings.isSyncing = false;
		this.settings.lastSyncFailed = false;
		//this.settings.currentSyncStatusID = 0;
		// if (exportID) {
		// 	this.settings.lastSavedStatusID = exportID;
		// }
		this.saveSettings();
		// if we have a button context, update the text on it
		// this is the case if we fired on a "Run sync" click (the button)
		if (buttonContext) {
			// this.showInfoStatus(
			// 	buttonContext.buttonEl.parentNode.parentElement,
			// 	msg,
			// 	"rw-success"
			// );
			buttonContext.buttonEl.setText("Run sync");
		}
	}

	handleSyncError(msg: string, buttonContext?: ButtonComponent) {
		this.settings.isSyncing = false;
		this.settings.lastSyncFailed = true;
		this.saveSettings();
		if (buttonContext) {
			// this.showInfoStatus(
			// 	buttonContext.buttonEl.parentElement,
			// 	msg,
			// 	"rw-error"
			// );
			buttonContext.buttonEl.setText("Run sync");
		} else {
			new Notice(msg);
		}
	}

	async requestData(buttonContext?: ButtonComponent) {
		let url = `${baseURL}/api/recipes/export/obsidian`;
		let response, data: ExportRequestResponse;
		try {
			response = await fetch(url, {
				headers: {
					...this.getAuthHeaders(),
					"Content-Type": "application/json",
				},
				method: "POST",
				body: JSON.stringify({
					exportTarget: "obsidian",
					recipeIds: this.settings.recipeIDs,
				}),
			});
		} catch (e) {
			console.log("Cooksync: fetch failed in requestArchive: ", e);
		}
		if (response && response.ok) {
			data = await response.json();

			// If data, then we have new data to add
			if (data) {
				//new Notice("Syncing Cooksync data");
				// const statusBarItemEl = this.addStatusBarItem();
				// statusBarItemEl.setText("Cooksync: Syncing data");
				// Parse response and save to Obsidian
				this.downloadData(data, buttonContext);
				//this.handleSyncSuccess(buttonContext);
				// new Notice(
				// 	"Latest Readwise sync already happened on your other device. Data should be up to date"
				// );
			}

			// If no data, then we are up to date
			if (!data) {
				this.handleSyncSuccess(buttonContext);
				new Notice("Cooksync data is already up to date");
				return;
			}

			await this.saveSettings();
			// if (response.status === 201) {
			// 	new Notice("Syncing Cooksync data");
			// 	//return this.getExportStatus(data.latest_id, buttonContext);
			// } else {
			// 	this.handleSyncSuccess(buttonContext, "Synced");
			// 	new Notice(
			// 		"Latest Readwise sync already happened on your other device. Data should be up to date"
			// 	);
			// }
		} else {
			console.log(
				"Cooksync plugin: bad response in requestData: ",
				response
			);
			this.handleSyncError(
				this.getErrorMessageFromResponse(response),
				buttonContext
			);
			return;
		}
	}

	async downloadData(
		data: any,
		buttonContext?: ButtonComponent
	): Promise<void> {
		console.log("Downloading data", data);

		this.fs = this.app.vault.adapter;

		const checkIfFileExists = async (fileName: string) => {
			const exists = await this.fs.exists(fileName);
			return exists;
		};

		for (const entry of data) {
			let recipeTitle = entry.title.replaceAll("/", ""); // TODO: sanitize title more
			let fileName = `${this.settings.cooksyncDir}/${recipeTitle}.md`;
			const processedFileName = normalizePath(fileName);
			console.log("processedFileName", processedFileName);
			try {
				// ensure the directory exists
				let dirPath = processedFileName
					.replace(/\/*$/, "")
					.replace(/^(.+)\/[^\/]*?$/, "$1");
				console.log("dirPath", dirPath);
				const exists = await this.fs.exists(dirPath);
				if (!exists) {
					await this.fs.mkdir(dirPath);
				}
				// write the actual files
				const content = entry.content;
				let originalName = processedFileName;
				let contentToSave = content;

				//let split = processedFileName.split("--");
				// if (split.length > 1) {
				// 	originalName = split.slice(0, -1).join("--") + ".md";
				// 	bookID = split.last().match(/\d+/g)[0];
				// 	this.settings.booksIDsMap[originalName] = bookID;
				// }

				const extension = originalName.split(".").pop();
				const baseName = originalName.replace(`.${extension}`, "");
				let count = 1;
				while (await checkIfFileExists(originalName)) {
					originalName = `${baseName} (${count}).${extension}`;
					count++;
				}
				console.log("recipe to save:", originalName);
				await this.fs.write(originalName, contentToSave);
				this.settings.recipeIDs.push(entry.id);
				this.settings.lastSyncTime = Date.now();
				await this.saveSettings();

				new Notice("Cooksync: sync completed");
				// if (await this.fs.exists(originalName)) {
				// 	// if the file already exists we will not do anything
				// 	return;
				// 	// const existingContent = await this.fs.read(originalName);
				// 	// contentToSave = existingContent + content;
				// }
				//await this.fs.write(originalName, contentToSave);
				//this.settings.recipeIDs.push(entry.id);
				//await this.saveSettings();
			} catch (e) {
				console.log(`Cooksync: error writing ${processedFileName}:`, e);
				new Notice(`Error writing file ${processedFileName}: ${e}`);
			}
		}

		//await this.acknowledgeSyncCompleted(buttonContext);
		this.handleSyncSuccess(buttonContext);
	}

	startSync() {
		if (this.settings.isSyncing) {
			new Notice("Cooksync sync already in progress");
		} else {
			this.settings.isSyncing = true;
			this.saveSettings();
			this.requestData();
		}
		console.log("started sync");
	}

	getObsidianClientID() {
		let obsidianClientId = window.localStorage.getItem(
			"cooksync-ObsidianClientId"
		);
		if (obsidianClientId) {
			return obsidianClientId;
		} else {
			obsidianClientId = Math.random().toString(36).substring(2, 15);
			window.localStorage.setItem(
				"cooksync-ObsidianClientId",
				obsidianClientId
			);
			return obsidianClientId;
		}
	}

	async getUserAuthToken(button: HTMLElement, attempt = 0) {
		let uuid = this.getObsidianClientID();
		console.log(uuid);

		if (attempt === 0) {
			window.open(`${baseURL}/export?uuid=${uuid}&service=obsidian`);
		}

		let response, data: AuthResponse;
		try {
			response = await fetch(`${baseURL}/api/clients/token?uuid=${uuid}`);
		} catch (e) {
			console.log(
				"Cooksync plugin: fetch failed in getUserAuthToken: ",
				e
			);
			new Notice("Authorization failed. Please try again");
		}
		if (response && response.ok) {
			data = await response.json();
			console.log("token", data);
		} else {
			console.log(
				"Cooksync plugin: bad response in getUserAuthToken: ",
				response
			);

			return;
		}
		if (data.token) {
			this.settings.token = data.token;
		} else {
			if (attempt > 50) {
				console.log(
					"Cooksync plugin: reached attempt limit in getUserAuthToken"
				);
				return;
			}
			console.log(
				`Cooksync plugin: didn't get token data, retrying (attempt ${
					attempt + 1
				})`
			);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			await this.getUserAuthToken(button, attempt + 1);
		}
		await this.saveSettings();
		return true;
	}
}

// class SampleModal extends Modal {
// 	constructor(app: App) {
// 		super(app);
// 	}

// 	onOpen() {
// 		const { contentEl } = this;
// 		contentEl.setText("Woah!");
// 	}

// 	onClose() {
// 		const { contentEl } = this;
// 		contentEl.empty();
// 	}
// }

class CooksyncSettingTab extends PluginSettingTab {
	plugin: Cooksync;

	constructor(app: App, plugin: Cooksync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h1", { text: "Cooksync" });
		containerEl.createEl("p", { text: "Created by " }).createEl("a", {
			text: "Cooksync",
			href: "https://cooksync.com",
		});
		containerEl.createEl("h2", { text: "Settings" });

		if (!this.plugin.settings.token) {
			new Setting(containerEl)
				.setName("Connect Obsidian to Cooksync")
				.setDesc(
					"Enable automatic syncing between Obsidian and Cooksync. Note: Requires Cooksync account"
				)
				.addButton((button) => {
					button
						.setButtonText("Connect")
						.setCta()
						.onClick(async (evt) => {
							const success = await this.plugin.getUserAuthToken(
								evt.target as HTMLElement
							);
							if (success) {
								this.display();
							}
						});
					// button
					// 	.setButtonText("Connect")
					// 	.setCta()
					// 	.onClick(() => {
					// 		new Notice("I've been clicked!");
					// 	});

					// button.setButtonText("Connect").setCta().onClick(async (evt) => {
					// 	const success = await this.plugin.getUserAuthToken(evt.target as HTMLElement);
					// 	if (success) {
					// 	  this.display();
					// 	}
					//   });
				});
		}

		// .addText((text) =>
		// 	text
		// 		.setPlaceholder("Enter your secret")
		// 		.setValue(this.plugin.settings.mySetting)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.mySetting = value;
		// 			await this.plugin.saveSettings();
		// 		})
		// );

		if (this.plugin.settings.token) {
			new Setting(containerEl)
				.setName("Sync your Cooksync data with Obsidian")
				.setDesc(
					"On first sync, the Cooksync plugin will create a new folder containing all your recipes"
				)
				.addButton((button) => {
					button
						.setCta()
						.setTooltip(
							"Once the sync begins, you can close this plugin page"
						)
						.setButtonText("Initiate Sync")
						.onClick(async () => {
							if (this.plugin.settings.isSyncing) {
								new Notice("Sync already in progress");
							} else {
								//this.plugin.clearInfoStatus(containerEl);
								this.plugin.settings.isSyncing = true;
								await this.plugin.saveData(
									this.plugin.settings
								);
								button.setButtonText("Syncing...");
								await this.plugin.requestData(button);
							}
						});
				});

			new Setting(containerEl)
				.setName("Customize import options")
				.setDesc("Customize recipe import, such as tags")
				.addButton((button) => {
					button.setButtonText("Customize").onClick(() => {
						window.open(`${baseURL}/export/obsidian`);
					});
				});

			new Setting(containerEl)
				.setName("Customize base folder")
				.setDesc(
					"By default, the plugin will save all your recipes into a folder named Cooksync"
				)
				.addText((text) =>
					text
						.setPlaceholder("Defaults to: Cooksync")
						.setValue(this.plugin.settings.cooksyncDir)
						.onChange(async (value) => {
							this.plugin.settings.cooksyncDir = normalizePath(
								value || "Cooksync"
							);
							await this.plugin.saveSettings();
						})
				);

			// .addSearch((search) =>
			// 	search

			// 		.setPlaceholder("Defaults to: Cooksync")
			// 		.setValue(this.plugin.settings.cooksyncDir)
			// 		.onChange(async (value) => {
			// 			this.plugin.settings.cooksyncDir = normalizePath(
			// 				value || "Cooksync"
			// 			);
			// 			await this.plugin.saveSettings();
			// 		})
			// );

			new Setting(containerEl)
				.setName("Sync automatically when Obsidian opens")
				.setDesc(
					"If enabled, Cooksync will automatically resync with Obsidian each time you open the app"
				)
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.triggerOnLoad);
					toggle.onChange((val) => {
						this.plugin.settings.triggerOnLoad = val;
						this.plugin.saveSettings();
					});
				});
		}

		const help = containerEl.createEl("p");
		help.innerHTML =
			"Issues? Please email us at <a href='mailto:info@cooksync.com'>info@cooksync.com</a>.";
	}
}
