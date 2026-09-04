/**
 * MetaInfoEditor - Edit metadata information for clips
 */

import { globalKeyDownManager } from "./keydown_manager.js";

class MetaInfoEditor {
    constructor(button, data, editor) {
        this.button = button;
        this.data = data;
        this.editor = editor;
        this.isActive = false;
        this.currentScene = null;
        this.metaInfo = null;
        this.config = null;
        this.overlayDiv = null;

        // Load config
        this.loadConfig();

        // Setup button click handler
        this.button.onclick = () => {
            this.toggle();
        };
    }

    async loadConfig() {
        try {
            const response = await fetch('/static/metainfo_config.json');
            this.config = await response.json();
        } catch (error) {
            console.error('Failed to load metainfo config:', error);
            this.config = {
                "label_version": ["unknown"],
                "sensor": ["unknown"],
                "lidar": ["unknown"],
                "camera": ["unknown"],
                "city": ["unknown"],
                "facility": ["unknown"],
                "status": ["unknown"]
            };
        }
    }

    toggle() {
        if (this.isActive) {
            this.hide();
        } else {
            this.show();
        }
    }

    async show() {
        // 首先尝试从 scene-selector 中获取当前选中的 scene
        // 这样即使在 F5 刷新后 data.world 还未加载的情况下也能工作
        let sceneName = null;
        const sceneSelector = document.querySelector('#scene-selector');
        if (sceneSelector && sceneSelector.value && sceneSelector.value !== '--scene--') {
            sceneName = sceneSelector.value;
        } else if (this.data.world && this.data.world.frameInfo) {
            sceneName = this.data.world.frameInfo.scene;
        }

        if (!sceneName) {
            alert('Please select a clip first');
            return;
        }

        this.currentScene = sceneName;
        this.isActive = true;

        // Update button state
        this.button.style.backgroundColor = 'var(--highlight-background-color)';
        this.button.style.borderColor = 'var(--highlight-color)';

        // Load meta info
        await this.loadMetaInfo();

        // Create overlay
        this.createOverlay();

        // Disable keyboard shortcuts
        globalKeyDownManager.register((event) => false, 'metainfo-editor');
    }

    hide() {
        this.isActive = false;

        // Reset button state
        this.button.style.backgroundColor = '';
        this.button.style.borderColor = '';

        // Remove overlay
        if (this.overlayDiv) {
            this.overlayDiv.remove();
            this.overlayDiv = null;
        }

        // Re-enable keyboard shortcuts
        globalKeyDownManager.deregister('metainfo-editor');
    }

    async loadMetaInfo() {
        try {
            const response = await fetch(`/data/${this.currentScene}/meta_info.json`);
            if (response.ok) {
                this.metaInfo = await response.json();
            } else {
                // Create default meta info if file doesn't exist
                this.metaInfo = this.createDefaultMetaInfo();
            }
        } catch (error) {
            console.error('Failed to load meta info:', error);
            this.metaInfo = this.createDefaultMetaInfo();
        }
    }

    createDefaultMetaInfo() {
        const defaultInfo = {};
        for (const key in this.config) {
            defaultInfo[key] = "unknown";
        }
        return defaultInfo;
    }

    createOverlay() {
        // Create overlay container
        this.overlayDiv = document.createElement('div');
        this.overlayDiv.id = 'metainfo-overlay';
        this.overlayDiv.style.position = 'fixed';
        this.overlayDiv.style.top = '0';
        this.overlayDiv.style.left = '0';
        this.overlayDiv.style.width = '100%';
        this.overlayDiv.style.height = '100%';
        this.overlayDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        this.overlayDiv.style.display = 'flex';
        this.overlayDiv.style.justifyContent = 'center';
        this.overlayDiv.style.alignItems = 'center';
        this.overlayDiv.style.zIndex = '1000';

        // Create editor panel
        const panel = document.createElement('div');
        panel.style.backgroundColor = 'var(--background-color)';
        panel.style.color = 'var(--font-color)';
        panel.style.padding = '30px';
        panel.style.borderRadius = '8px';
        panel.style.minWidth = '400px';
        panel.style.maxWidth = '600px';
        panel.style.maxHeight = '80vh';
        panel.style.overflow = 'auto';
        panel.style.border = '2px solid var(--widget-color)';

        // Title
        const title = document.createElement('h2');
        title.textContent = `Meta Info - ${this.currentScene}`;
        title.style.marginTop = '0';
        title.style.marginBottom = '20px';
        title.style.fontSize = '18px';
        panel.appendChild(title);

        // Create form
        const form = this.createForm();
        panel.appendChild(form);

        // Create buttons
        const buttonsDiv = this.createButtons();
        panel.appendChild(buttonsDiv);

        this.overlayDiv.appendChild(panel);

        // Add overlay to document
        document.body.appendChild(this.overlayDiv);

        // Click outside to close
        this.overlayDiv.onclick = (e) => {
            if (e.target === this.overlayDiv) {
                this.hide();
            }
        };

        // ESC key to close
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                this.hide();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    createForm() {
        const form = document.createElement('form');
        form.id = 'metainfo-form';

        for (const key in this.config) {
            const options = this.config[key];
            const currentValue = this.metaInfo[key] !== undefined ? this.metaInfo[key] : "unknown";

            const fieldDiv = document.createElement('div');
            fieldDiv.style.marginBottom = '15px';

            const label = document.createElement('label');
            label.textContent = key.replace(/_/g, ' ').toUpperCase() + ':';
            label.style.display = 'block';
            label.style.marginBottom = '5px';
            label.style.fontSize = '14px';
            label.style.fontWeight = 'bold';
            fieldDiv.appendChild(label);

            const select = document.createElement('select');
            select.name = key;
            select.style.width = '100%';
            select.style.padding = '8px';
            select.style.backgroundColor = 'var(--widget-background-color)';
            select.style.color = 'var(--font-color)';
            select.style.border = '1px solid var(--widget-color)';
            select.style.borderRadius = '4px';
            select.style.fontSize = '14px';

            // Ensure the current value is present as an option even if config missed it
            let hasCurrent = false;
            options.forEach(optionValue => {
                const option = document.createElement('option');
                option.value = optionValue;
                option.textContent = optionValue;
                if (optionValue === currentValue) {
                    option.selected = true;
                    hasCurrent = true;
                }
                select.appendChild(option);
            });
            if (!hasCurrent) {
                const option = document.createElement('option');
                option.value = currentValue;
                option.textContent = currentValue + ' (not in config)';
                option.selected = true;
                select.insertBefore(option, select.firstChild);
            }

            fieldDiv.appendChild(select);
            form.appendChild(fieldDiv);
        }

        return form;
    }

    createButtons() {
        const buttonsDiv = document.createElement('div');
        buttonsDiv.style.marginTop = '25px';
        buttonsDiv.style.display = 'flex';
        buttonsDiv.style.gap = '10px';
        buttonsDiv.style.justifyContent = 'flex-end';

        const saveButton = document.createElement('button');
        saveButton.textContent = 'Save';
        saveButton.type = 'button';
        saveButton.style.padding = '8px 20px';
        saveButton.style.backgroundColor = 'var(--highlight-color)';
        saveButton.style.color = 'var(--background-color)';
        saveButton.style.border = 'none';
        saveButton.style.borderRadius = '4px';
        saveButton.style.cursor = 'pointer';
        saveButton.style.fontSize = '14px';
        saveButton.style.fontWeight = 'bold';
        saveButton.onclick = () => this.save();
        buttonsDiv.appendChild(saveButton);

        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Cancel';
        cancelButton.type = 'button';
        cancelButton.style.padding = '8px 20px';
        cancelButton.style.backgroundColor = 'var(--widget-background-color)';
        cancelButton.style.color = 'var(--font-color)';
        cancelButton.style.border = '1px solid var(--widget-color)';
        cancelButton.style.borderRadius = '4px';
        cancelButton.style.cursor = 'pointer';
        cancelButton.style.fontSize = '14px';
        cancelButton.onclick = () => this.hide();
        buttonsDiv.appendChild(cancelButton);

        return buttonsDiv;
    }

    async save() {
        const form = document.getElementById('metainfo-form');
        const formData = new FormData(form);

        const updatedMetaInfo = {};
        for (const [key, value] of formData.entries()) {
            updatedMetaInfo[key] = value;
        }

        try {
            const response = await fetch('/save_metainfo', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    scene: this.currentScene,
                    meta_info: updatedMetaInfo
                })
            });

            if (response.ok) {
                this.metaInfo = updatedMetaInfo;
                this.hide();
                console.log('Meta info saved successfully');
            } else {
                const error = await response.text();
                alert('Failed to save meta info: ' + error);
            }
        } catch (error) {
            console.error('Failed to save meta info:', error);
            alert('Failed to save meta info: ' + error.message);
        }
    }
}

export { MetaInfoEditor };
