class FalAI {
    constructor() {
        this.apiKey = localStorage.getItem('falai_api_key') || sessionStorage.getItem('falai_api_key') || '';
        this.endpoints = new Map();
        this.currentEndpoint = null;
        this.currentRequestId = null;
        this.statusPolling = null;

        // Try to load settings from both storages and merge/pick best
        const localSettings = JSON.parse(localStorage.getItem('falai_endpoint_settings') || '{}');
        const sessionSettings = JSON.parse(sessionStorage.getItem('falai_endpoint_settings') || '{}');

        // If session has data but local doesn't (or is smaller/older?), prefer session
        // Since we don't have timestamps, we'll prefer session if it has more keys or if local is empty
        const localKeys = Object.keys(localSettings).length;
        const sessionKeys = Object.keys(sessionSettings).length;

        if (sessionKeys > 0 && (localKeys === 0 || this.isStorageBlocked())) {
            this.endpointSettings = sessionSettings;
            console.log('🔧 Loaded settings from SessionStorage (fallback)');
        } else {
            this.endpointSettings = localSettings;
        }

        this.debugMode = (localStorage.getItem('falai_debug_mode') || sessionStorage.getItem('falai_debug_mode')) === 'true';

        if (this.debugMode) {
            console.log('🔧 Initialized with settings:', this.endpointSettings);
        }

        // Persistent generation state
        this.isGenerating = false;

        // Initialize gallery (deferred to unblock main thread)
        setTimeout(() => {
            this.gallery = new FalAIGallery(this);
        }, 0);

        this.init();
    }

    isStorageBlocked() {
        try {
            localStorage.setItem('test_storage', '1');
            localStorage.removeItem('test_storage');
            return false;
        } catch (e) {
            return true;
        }
    }

    // Extract the input (request body) schema from an endpoint OpenAPI schema
    getInputSchema(openApiSchema) {
        if (!openApiSchema) return null;
        try {
            // Typical structure: components.schemas.Input / Request / or first schema in requestBody
            // 1. Try x-fal-metadata reference
            const paths = openApiSchema.paths || {};
            // Find first path with post + requestBody
            for (const p of Object.keys(paths)) {
                const post = paths[p].post || paths[p].get || paths[p].put;
                if (post && post.requestBody) {
                    const content = post.requestBody.content || {};
                    const appJson = content['application/json'];
                    if (appJson && appJson.schema) {
                        // If schema is a $ref
                        if (appJson.schema.$ref) {
                            const refName = appJson.schema.$ref.split('/').pop();
                            return openApiSchema.components && openApiSchema.components.schemas ? openApiSchema.components.schemas[refName] : null;
                        }
                        return appJson.schema; // Direct schema object
                    }
                }
            }

            // 2. Fallback: look for first schema with properties
            if (openApiSchema.components && openApiSchema.components.schemas) {
                for (const key of Object.keys(openApiSchema.components.schemas)) {
                    const candidate = openApiSchema.components.schemas[key];
                    if (candidate && candidate.properties) return candidate;
                }
            }
        } catch (e) {
            console.warn('Failed to extract input schema', e);
        }
        return null;
    }

    logDebug(message, type = 'info', data = null) {
        if (!this.debugMode) return;

        const timestamp = new Date().toLocaleTimeString();
        const typeLabel = {
            'info': '[INFO]',
            'success': '[SUCCESS]',
            'error': '[ERROR]',
            'warning': '[WARNING]',
            'system': '[SYSTEM]',
            'request': '[REQUEST]',
            'response': '[RESPONSE]',
            'status': '[STATUS]'
        }[type] || '[INFO]';

        if (data) {
            console.group(`${typeLabel} [${timestamp}] ${message}`);
            console.log(data);
            console.groupEnd();
        } else {
            console.log(`${typeLabel} [${timestamp}] ${message}`);
        }
    }

    async init() {
        await this.loadEndpoints();
        this.loadCustomEndpoints();
        this.renderEndpointDropdown(); // Re-render after loading custom endpoints
        this.setupEventListeners();
        this.restoreUIState();
        this.setupPWA();
        this.initDebugMode();
        this.initTheme();

        // Log storage info on startup if debug mode is enabled
        if (this.debugMode) {
            this.logStorageInfo();
        } else {
            // Always log if storage is critically full (>90%)
            const info = this.getStorageSize();
            if (parseFloat(info.usage) > 90) {
                console.warn(`[WARNING] Storage ${info.usage}% full! Run falaiStorage.info() for details`);
            }
        }

        // Check for incomplete generation on startup
        this.checkIncompleteGeneration();

        // Make storage functions available globally for debugging
        window.falaiStorage = {
            info: () => this.logStorageInfo(),
            cleanup: () => {
                console.log('[CLEANUP] Starting cleanup...');
                const base64 = this.cleanupBase64Images();
                const settings = this.cleanupOldSettings();
                const gallery = this.gallery.cleanupOldGalleryImages();
                console.log(`[SUCCESS] Cleanup complete:`);
                console.log(`  [IMAGES] Base64 images: ${base64.count} removed (${this.formatBytes(base64.sizeFreed)} freed)`);
                console.log(`  [SETTINGS] Settings: ${settings} removed`);
                console.log(`  [GALLERY] Gallery: ${gallery} entries removed`);
                this.logStorageInfo();
            },
            cleanBase64: () => {
                const result = this.cleanupBase64Images();
                console.log(`Removed ${result.count} base64 images, freed ${this.formatBytes(result.sizeFreed)}`);
                this.logStorageInfo();
            },
            clear: () => {
                this.gallery.savedImages = [];
                localStorage.setItem('falai_saved_images', '[]');
                console.log('Gallery cleared');
                this.logStorageInfo();
            },
            findLargest: () => {
                console.log('[SEARCH] Finding largest localStorage entries...');
                const entries = [];
                for (let key in localStorage) {
                    if (localStorage.hasOwnProperty(key)) {
                        const value = localStorage.getItem(key);
                        const size = new Blob([value]).size;
                        entries.push({ key, size, preview: value.substring(0, 100) + (value.length > 100 ? '...' : '') });
                    }
                }
                entries.sort((a, b) => b.size - a.size);
                entries.slice(0, 10).forEach((entry, i) => {
                    console.log(`${i + 1}. ${entry.key}: ${this.formatBytes(entry.size)}`);
                    console.log(`   Preview: ${entry.preview}`);
                });
                return entries;
            },
            analyzeGallery: () => {
                this.gallery.analyzeGallery();
            },
            cleanGalleryBase64: () => {
                this.gallery.cleanGalleryBase64();
            }
        };
    }

    initDebugMode() {
        const debugCheckbox = document.getElementById('debug-checkbox');

        // Restore debug mode state
        debugCheckbox.checked = this.debugMode;
        if (this.debugMode) {
            this.logDebug('Debug mode restored', 'system');
        }
    }

    initTheme() {
        // Initial check
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
        this.applyTheme(prefersDark.matches);

        // Listen for changes
        prefersDark.addEventListener('change', (e) => {
            this.applyTheme(e.matches);
        });
    }

    applyTheme(isDark) {
        if (isDark) {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    }

    async loadEndpoints() {
        await this.loadEndpointsManually();
        this.renderEndpointDropdown();
    }

    async loadEndpointsManually() {
        const knownEndpoints = [
            'endpoints/flux-pro/kontext/openapi.json',
            'endpoints/flux-krea-lora/openapi.json',
            'endpoints/flux-lora/openapi.json',
            'endpoints/flux-kontext/dev/openapi.json',
            'endpoints/flux-2/openapi.json',
            'endpoints/flux-2/edit/openapi.json'
        ];

        // Load all endpoints in parallel
        await Promise.all(knownEndpoints.map(path => this.loadEndpoint(path, false)));
    }

    async loadEndpoint(path, shouldRender = true) {
        try {
            const response = await fetch(path);
            if (!response.ok) {
                console.warn(`Failed to load endpoint from ${path}`);
                return;
            }

            const schema = await response.json();
            const metadata = schema.info?.['x-fal-metadata'];

            if (!metadata) {
                console.warn(`No fal metadata found in ${path}`);
                return;
            }

            const endpoint = {
                path,
                schema,
                metadata,
                title: schema.info.title,
                description: schema.info.description
            };

            this.endpoints.set(metadata.endpointId, endpoint);
            console.log(`Loaded endpoint: ${metadata.endpointId}`);

            // Re-render dropdown only if requested
            if (shouldRender) {
                this.renderEndpointDropdown();
            }
        } catch (error) {
            console.warn(`Error loading endpoint ${path}:`, error);
        }
    }

    renderEndpointDropdown() {
        const dropdown = document.getElementById('endpoint-dropdown');
        if (!dropdown) {
            console.warn('endpoint-dropdown element not found');
            return;
        }

        // CRITICAL: Preserve the currently selected endpoint before clearing
        // This prevents form from being overwritten during incremental endpoint loading
        const previouslySelected = dropdown.value || this.currentEndpointId;

        dropdown.innerHTML = '<option value="">Choose an endpoint...</option>';

        console.log(`Rendering dropdown with ${this.endpoints.size} endpoints`);

        // Convert endpoints to array and sort alphabetically by endpoint name
        const sortedEndpoints = Array.from(this.endpoints.entries()).sort((a, b) => {
            const nameA = a[1].metadata.endpointId.toLowerCase();
            const nameB = b[1].metadata.endpointId.toLowerCase();
            return nameA.localeCompare(nameB);
        });

        for (const [id, endpoint] of sortedEndpoints) {
            const option = document.createElement('option');
            option.value = id;
            const isCustom = id.startsWith('custom-');
            option.textContent = `${endpoint.metadata.endpointId} (${endpoint.metadata.category})${isCustom ? ' [Custom]' : ''}`;
            dropdown.appendChild(option);
        }

        // Update delete button visibility for current selection
        this.updateDeleteButtonVisibility(dropdown.value);

        // Restore previously selected endpoint if it still exists
        // OR auto-select last used endpoint on initial load only
        if (previouslySelected && this.endpoints.has(previouslySelected)) {
            dropdown.value = previouslySelected;
            // Only call selectEndpoint if form is not already showing this endpoint
            if (this.currentEndpointId !== previouslySelected) {
                this.selectEndpoint(previouslySelected);
            }
            this.updateDeleteButtonVisibility(previouslySelected);
        } else if (!this.currentEndpointId) {
            // Initial load - auto-select last used endpoint
            const lastEndpoint = localStorage.getItem('falai_last_endpoint');
            if (lastEndpoint && this.endpoints.has(lastEndpoint)) {
                dropdown.value = lastEndpoint;
                this.selectEndpoint(lastEndpoint);
                this.updateDeleteButtonVisibility(lastEndpoint);
            }
        }
    }

    selectEndpoint(endpointId, forceRegenerate = false) {
        const endpoint = this.endpoints.get(endpointId);
        if (!endpoint) return;

        // Skip if same endpoint and not forcing regenerate
        if (!forceRegenerate && this.currentEndpointId === endpointId) {
            return;
        }

        // Save current endpoint settings before switching
        if (this.currentEndpoint) {
            this.performSaveEndpointSettings();
        }

        this.currentEndpoint = endpoint;
        this.currentEndpointId = endpointId;

        this.showEndpointInfo();
        this.generateForm();
        this.hideResults();
    }

    clearEndpointSelection() {
        this.currentEndpoint = null;
        this.currentEndpointId = null;

        // Hide endpoint info and form
        document.getElementById('endpoint-info').classList.add('hidden');
        document.getElementById('api-form').classList.add('hidden');

        this.hideResults();
    }

    showEndpointInfo() {
        const endpoint = this.currentEndpoint;
        const info = document.getElementById('endpoint-info');

        document.getElementById('endpoint-thumbnail').src = endpoint.metadata.thumbnailUrl;
        document.getElementById('endpoint-title').textContent = endpoint.metadata.endpointId;
        document.getElementById('endpoint-category').textContent = endpoint.metadata.category;
        document.getElementById('playground-link').href = endpoint.metadata.playgroundUrl;
        document.getElementById('docs-link').href = endpoint.metadata.documentationUrl;

        info.classList.remove('hidden');
    }

    updateDeleteButtonVisibility(endpointId) {
        const deleteBtn = document.getElementById('delete-endpoint-btn');
        if (!deleteBtn) {
            console.warn('delete-endpoint-btn element not found in updateDeleteButtonVisibility');
            return;
        }

        if (endpointId && endpointId.startsWith('custom-')) {
            deleteBtn.classList.remove('hidden');
        } else {
            deleteBtn.classList.add('hidden');
        }
    }

    deleteCurrentEndpoint() {
        console.log('deleteCurrentEndpoint called, currentEndpointId:', this.currentEndpointId);

        if (!this.currentEndpointId || !this.currentEndpointId.startsWith('custom-')) {
            console.log('Not a custom endpoint or no endpoint selected');
            return;
        }

        const endpoint = this.endpoints.get(this.currentEndpointId);
        if (!endpoint) {
            console.log('Endpoint not found');
            return;
        }

        const endpointName = endpoint.metadata.endpointId;
        console.log('Deleting endpoint:', endpointName);

        if (confirm(`Are you sure you want to delete the custom endpoint "${endpointName}"? This action cannot be undone.`)) {
            // Remove from endpoints map
            this.endpoints.delete(this.currentEndpointId);

            // Update storage
            this.saveCustomEndpoints();

            // Update UI
            this.renderEndpointDropdown();
            this.clearEndpointSelection();
            this.updateDeleteButtonVisibility(null);

            // Reset dropdown selection
            document.getElementById('endpoint-dropdown').value = '';

            // Show success message
            this.logDebug(`Successfully deleted custom endpoint: ${endpointName}`, 'success');

            // Show alert if debug is disabled
            if (!this.debugMode) {
                alert(`Successfully deleted custom endpoint: ${endpointName}`);
            }
        }
    }

    generateForm() {
        const endpoint = this.currentEndpoint;
        const schema = endpoint.schema;

        // Find the input schema
        const inputSchema = this.findInputSchema(schema);
        if (!inputSchema) {
            console.error('Could not find input schema');
            return;
        }

        const container = document.getElementById('form-fields');
        container.innerHTML = '';

        // Generate form fields based on schema
        this.generateFormFields(inputSchema, container);

        // Restore saved settings for this endpoint
        this.restoreEndpointSettings(endpoint.metadata.endpointId);

        document.getElementById('api-form').classList.remove('hidden');
    }

    findInputSchema(schema) {
        // Look for POST endpoint that accepts the input
        for (const [path, methods] of Object.entries(schema.paths)) {
            if (methods.post && methods.post.requestBody) {
                const content = methods.post.requestBody.content;
                if (content['application/json'] && content['application/json'].schema) {
                    const schemaRef = content['application/json'].schema;
                    return this.resolveSchema(schemaRef, schema);
                }
            }
        }
        return null;
    }

    resolveSchema(schemaRef, rootSchema) {
        if (schemaRef.$ref) {
            const refPath = schemaRef.$ref.replace('#/', '').split('/');
            let resolved = rootSchema;
            for (const part of refPath) {
                resolved = resolved[part];
            }
            return resolved;
        }
        return schemaRef;
    }

    generateFormFields(schema, container) {
        const properties = schema.properties || {};
        const required = schema.required || [];
        const order = schema['x-fal-order-properties'] || Object.keys(properties);

        // Create main fields container
        const mainFields = document.createElement('div');
        mainFields.className = 'main-fields';

        // Create advanced options container
        const advancedContainer = document.createElement('div');
        advancedContainer.className = 'advanced-options';
        advancedContainer.innerHTML = `
            <button type="button" class="advanced-options-toggle">
                <i class="ph ph-caret-down"></i> Advanced Options
            </button>
            <div class="advanced-options-content"></div>
        `;

        const advancedContent = advancedContainer.querySelector('.advanced-options-content');
        const toggle = advancedContainer.querySelector('.advanced-options-toggle');

        toggle.addEventListener('click', () => {
            advancedContent.classList.toggle('visible');
            toggle.innerHTML = advancedContent.classList.contains('visible')
                ? '<i class="ph ph-caret-up"></i> Advanced Options'
                : '<i class="ph ph-caret-down"></i> Advanced Options';
        });

        // Only show prompt in main fields, everything else goes to advanced options
        for (const fieldName of order) {
            const fieldSchema = properties[fieldName];
            if (!fieldSchema) continue;

            const isRequired = required.includes(fieldName);
            const field = this.createFormField(fieldName, fieldSchema, isRequired);

            // Determine which fields should be in main interface vs advanced options
            const isMainField = fieldName === 'prompt' ||
                (fieldName.includes('image') && fieldName.includes('_url')) ||
                fieldName.includes('mask') ||
                fieldName.includes('reference');

            if (isMainField) {
                // Main fields: prompt and all image/mask fields
                mainFields.appendChild(field);
            } else {
                // All other fields go to advanced options
                advancedContent.appendChild(field);
            }
        }

        const actionsContainer = this.createGenerationButtons();
        if (mainFields.children.length > 0) {
            mainFields.appendChild(actionsContainer);
        } else {
            container.appendChild(actionsContainer);
        }

        // Ensure advanced options are visible if they contain required fields that are empty
        // or if the user has previously expanded them
        const savedAdvancedVisible = localStorage.getItem('falai_advanced_visible') === 'true';
        if (savedAdvancedVisible) {
            advancedContent.classList.add('visible');
            toggle.innerHTML = '<i class="ph ph-caret-up"></i> Advanced Options';
        }

        toggle.addEventListener('click', () => {
            const isVisible = advancedContent.classList.toggle('visible');
            toggle.innerHTML = isVisible
                ? '<i class="ph ph-caret-up"></i> Advanced Options'
                : '<i class="ph ph-caret-down"></i> Advanced Options';
            localStorage.setItem('falai_advanced_visible', isVisible);
        });

        container.appendChild(mainFields);
        container.appendChild(advancedContainer);
    }

    createGenerationButtons() {
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'prompt-buttons';

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.id = 'reset-btn';
        resetBtn.className = 'btn secondary';
        resetBtn.textContent = 'Reset';
        resetBtn.addEventListener('click', () => {
            this.resetFormToDefaults();
        });

        const generateBtn = document.createElement('button');
        generateBtn.type = 'submit';
        generateBtn.className = 'btn primary generate-btn';
        generateBtn.innerHTML = `
            <span class="generate-text">Generate</span>
            <span class="generate-loading hidden">Generating...</span>
        `;

        buttonContainer.appendChild(resetBtn);
        buttonContainer.appendChild(generateBtn);

        return buttonContainer;
    }

    createFormField(name, schema, required = false) {
        const field = document.createElement('div');
        field.className = 'form-field';

        const label = document.createElement('label');
        label.textContent = (schema.title || name) + (required ? ' *' : '');
        label.setAttribute('for', name);

        let input;

        // Handle anyOf schemas, preferring enum options or the first non-null variant.
        if (schema.anyOf && schema.anyOf.length > 0) {
            const enumSchema = schema.anyOf.find(option => option.enum);
            if (enumSchema) {
                schema = { ...schema, enum: enumSchema.enum };
            } else {
                const firstConcreteOption = schema.anyOf.find(option => option.type !== 'null') || schema.anyOf[0];
                schema = { ...schema, ...firstConcreteOption };
            }
        }

        // Handle image URL fields with file upload
        if (name.includes('image_url') || name.includes('mask_url') ||
            (name.includes('image') && schema.type === 'string' && !schema.enum) ||
            (name.includes('mask') && schema.type === 'string' && !schema.enum)) {
            return this.createImageUploadField(name, schema, required, label, field);
        }

        // Handle array fields (like loras)
        if (schema.type === 'array') {
            return this.createArrayField(name, schema, required, label, field);
        }

        if (schema.enum) {
            // Special handling for image_size field
            if (name === 'image_size') {
                return this.createImageSizeField(name, schema, required, label, field);
            }

            input = document.createElement('select');
            input.innerHTML = '<option value="">Select...</option>';
            for (const option of schema.enum) {
                const opt = document.createElement('option');
                opt.value = String(option);
                opt.textContent = option;
                opt.dataset.valueType = typeof option;
                input.appendChild(opt);
            }
        } else if (schema.type === 'boolean') {
            input = document.createElement('input');
            input.type = 'checkbox';
        } else if (schema.type === 'integer' || schema.type === 'number') {
            // Create range slider for numeric fields with min/max
            if (schema.minimum !== undefined && schema.maximum !== undefined) {
                return this.createSliderField(name, schema, required, label, field);
            }

            input = document.createElement('input');
            input.type = 'number';
            if (schema.minimum !== undefined) input.min = schema.minimum;
            if (schema.maximum !== undefined) input.max = schema.maximum;
            if (schema.multipleOf !== undefined) input.step = schema.multipleOf;
            if (schema.default !== undefined) input.value = schema.default;
        } else if (schema.description && schema.description.length > 100) {
            input = document.createElement('textarea');
        } else {
            input = document.createElement('input');
            input.type = schema.format === 'password' ? 'password' : 'text';
        }

        // Add example prompts for prompt field
        if (name === 'prompt') {
            return this.createPromptField(name, schema, required, label, field);
        }

        input.id = name;
        input.name = name;

        if (schema.default !== undefined && input.type !== 'checkbox') {
            input.value = schema.default;
        } else if (schema.default !== undefined && input.type === 'checkbox') {
            input.checked = schema.default;
        }

        if (required) {
            input.required = true;
        }

        field.appendChild(label);
        field.appendChild(input);

        if (schema.description) {
            const desc = document.createElement('div');
            desc.className = 'field-description';
            desc.textContent = schema.description;
            field.appendChild(desc);
        }

        // Add change listener to save settings
        input.addEventListener('change', () => {
            if (!this.isRestoring) this.saveEndpointSettings(name);
        });

        return field;
    }

    createPromptField(name, schema, required, label, field) {
        field.appendChild(label);

        const promptContainer = document.createElement('div');
        promptContainer.className = 'prompt-container';

        const textarea = document.createElement('textarea');
        textarea.id = name;
        textarea.name = name;
        textarea.placeholder = 'Describe the image you want to generate...';
        textarea.rows = 3;
        if (required) textarea.required = true;

        textarea.addEventListener('input', () => {
            if (!this.isRestoring) this.saveEndpointSettings(name);
        });

        promptContainer.appendChild(textarea);
        field.appendChild(promptContainer);

        if (schema.description) {
            const desc = document.createElement('div');
            desc.className = 'field-description';
            desc.textContent = schema.description;
            field.appendChild(desc);
        }

        return field;
    }

    createImageUploadField(name, schema, required, label, field) {
        // Check if this field expects multiple images (array type)
        const isMultiImage = schema.type === 'array' && schema.items?.type === 'string';

        if (isMultiImage) {
            return this.createMultiImageUploadField(name, schema, required, label, field);
        }

        field.appendChild(label);

        const uploadContainer = document.createElement('div');
        uploadContainer.className = 'image-upload-container';

        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.id = name;
        urlInput.name = name;
        urlInput.placeholder = 'Enter image URL or upload file';
        if (required) urlInput.required = true;

        // Paste button
        const pasteBtn = document.createElement('button');
        pasteBtn.type = 'button';
        pasteBtn.className = 'btn secondary small paste-image-btn';
        pasteBtn.innerHTML = '<i class="ph ph-clipboard"></i> Paste';
        pasteBtn.title = 'Paste image from clipboard';
        pasteBtn.style.marginBottom = '0.5rem';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';

        const uploadArea = document.createElement('div');
        uploadArea.className = 'upload-area';

        // Check if this is a mask field for inpainting
        const isMaskField = name.toLowerCase().includes('mask');

        if (isMaskField) {
            uploadArea.innerHTML = `
                <div class="upload-content">
                    <span><i class="ph ph-paint-brush"></i> Create mask or upload image</span>
                    <small>Draw on reference image or upload mask file</small>
                </div>
            `;
        } else {
            uploadArea.innerHTML = `
                <div class="upload-content">
                    <span><i class="ph ph-upload-simple"></i> Drop image here or click to upload</span>
                    <small>Supports: JPG, PNG, WebP, GIF</small>
                </div>
            `;
        }

        const preview = document.createElement('div');
        preview.className = 'image-preview hidden';
        preview.innerHTML = `
            <img src="" alt="Preview" style="max-width: 200px; max-height: 200px; border-radius: 4px;">
            <button type="button" class="remove-image btn secondary small">Remove</button>
        `;

        // Add mask editor for mask fields
        if (isMaskField) {
            const maskEditorContainer = document.createElement('div');
            maskEditorContainer.className = 'mask-editor-container hidden';

            const maskEditorButton = document.createElement('button');
            maskEditorButton.type = 'button';
            maskEditorButton.className = 'btn secondary small mask-editor-btn';
            maskEditorButton.innerHTML = '<i class="ph ph-paint-brush"></i> Draw Mask';
            maskEditorButton.style.marginTop = '8px';

            maskEditorButton.addEventListener('click', () => {
                this.openMaskEditor(name, urlInput);
            });

            uploadContainer.appendChild(maskEditorButton);
        }

        // Upload area click
        uploadArea.addEventListener('click', () => {
            fileInput.click();
        });

        // Drag and drop
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('drag-over');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('drag-over');
        });

        uploadArea.addEventListener('drop', async (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                await this.handleFileUpload(files[0], urlInput, uploadArea, preview);
            }
        });

        // File input change
        fileInput.addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                await this.handleFileUpload(e.target.files[0], urlInput, uploadArea, preview);
            }
        });

        // Paste from clipboard
        pasteBtn.addEventListener('click', async () => {
            await this.pasteImageFromClipboard((dataURL) => {
                urlInput.value = dataURL;
                this.showImagePreview(dataURL, uploadArea, preview);
                this.autoSetImageDimensions(dataURL);
                if (!this.isRestoring) this.saveEndpointSettings(name);
            });
        });

        // Remove button
        preview.querySelector('.remove-image').addEventListener('click', () => {
            urlInput.value = '';
            uploadArea.classList.remove('hidden');
            preview.classList.add('hidden');
            if (!this.isRestoring) this.saveEndpointSettings(name);
        });

        // URL input change
        urlInput.addEventListener('input', () => {
            if (urlInput.value) {
                this.showImagePreview(urlInput.value, uploadArea, preview);

                // Auto-set custom dimensions based on image URL
                this.autoSetImageDimensions(urlInput.value);
            } else {
                uploadArea.classList.remove('hidden');
                preview.classList.add('hidden');
            }
            if (!this.isRestoring) this.saveEndpointSettings(name);
        });

        uploadContainer.appendChild(urlInput);
        uploadContainer.appendChild(pasteBtn);
        uploadContainer.appendChild(uploadArea);
        uploadContainer.appendChild(preview);
        uploadContainer.appendChild(fileInput);

        field.appendChild(uploadContainer);

        if (schema.description) {
            const desc = document.createElement('div');
            desc.className = 'field-description';
            desc.textContent = schema.description;
            field.appendChild(desc);
        }

        return field;
    }

    createMultiImageUploadField(name, schema, required, label, field) {
        field.appendChild(label);

        const uploadContainer = document.createElement('div');
        uploadContainer.className = 'multi-image-upload-container';
        uploadContainer.dataset.fieldName = name;

        // Hidden input to store JSON array of image URLs
        const hiddenInput = document.createElement('input');
        hiddenInput.type = 'hidden';
        hiddenInput.id = name;
        hiddenInput.name = name;
        hiddenInput.value = '';

        // Container for image previews
        const previewsContainer = document.createElement('div');
        previewsContainer.className = 'multi-image-previews';
        previewsContainer.id = `${name}-previews`;

        // File input for multiple files
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        fileInput.id = `${name}-file-input`;

        // Upload area
        const uploadArea = document.createElement('div');
        uploadArea.className = 'upload-area multi-upload-area';
        uploadArea.innerHTML = `
            <div class="upload-content">
                <span><i class="ph ph-images"></i> Drop images here or click to upload</span>
                <small>Supports: JPG, PNG, WebP, GIF (max 4 images)</small>
            </div>
        `;

        // URL input for manual entry
        const urlInputContainer = document.createElement('div');
        urlInputContainer.className = 'url-input-container';
        urlInputContainer.innerHTML = `
            <input type="text" class="url-text-input" placeholder="Or paste image URL and press Enter">
            <button type="button" class="btn secondary small paste-from-clipboard-btn" title="Paste image from clipboard"><i class="ph ph-clipboard"></i></button>
            <button type="button" class="btn secondary small add-url-btn"><i class="ph ph-plus"></i></button>
        `;

        const urlTextInput = urlInputContainer.querySelector('.url-text-input');
        const pasteBtn = urlInputContainer.querySelector('.paste-from-clipboard-btn');
        const addUrlBtn = urlInputContainer.querySelector('.add-url-btn');

        // Helper to get current images array
        const getImages = () => {
            try {
                const val = hiddenInput.value;
                return val ? JSON.parse(val) : [];
            } catch {
                return [];
            }
        };

        // Helper to set images array
        const setImages = (images) => {
            hiddenInput.value = images.length > 0 ? JSON.stringify(images) : '';
            this.renderMultiImagePreviews(name, images, previewsContainer, hiddenInput);
            if (!this.isRestoring) this.saveEndpointSettings(name);
        };

        // Add image to array
        const addImage = (imageUrl) => {
            const images = getImages();
            if (images.length >= 4) {
                this.showToast('Limit Reached', 'Maximum 4 images allowed', 'warning');
                return false;
            }
            if (images.includes(imageUrl)) {
                this.showToast('Duplicate', 'This image is already added', 'warning');
                return false;
            }
            images.push(imageUrl);
            setImages(images);
            return true;
        };

        // Upload area click
        uploadArea.addEventListener('click', () => {
            if (getImages().length >= 4) {
                this.showToast('Limit Reached', 'Maximum 4 images allowed', 'warning');
                return;
            }
            fileInput.click();
        });

        // Drag and drop
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('drag-over');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('drag-over');
        });

        uploadArea.addEventListener('drop', async (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
            for (const file of files) {
                if (getImages().length >= 4) break;
                await this.handleMultiFileUpload(file, addImage);
            }
        });

        // File input change
        fileInput.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files);
            for (const file of files) {
                if (getImages().length >= 4) break;
                await this.handleMultiFileUpload(file, addImage);
            }
            fileInput.value = ''; // Reset to allow re-uploading same file
        });

        // URL input handlers
        const handleAddUrl = () => {
            const url = urlTextInput.value.trim();
            if (url) {
                addImage(url);
                urlTextInput.value = '';
            }
        };

        urlTextInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleAddUrl();
            }
        });

        addUrlBtn.addEventListener('click', handleAddUrl);

        // Paste from clipboard handler
        pasteBtn.addEventListener('click', async () => {
            await this.pasteImageFromClipboard(addImage);
        });

        // Store addImage function for external use (e.g., from gallery)
        uploadContainer.addImage = addImage;
        uploadContainer.getImages = getImages;
        uploadContainer.setImages = setImages;

        uploadContainer.appendChild(hiddenInput);
        uploadContainer.appendChild(previewsContainer);
        uploadContainer.appendChild(uploadArea);
        uploadContainer.appendChild(urlInputContainer);
        uploadContainer.appendChild(fileInput);

        field.appendChild(uploadContainer);

        if (schema.description) {
            const desc = document.createElement('div');
            desc.className = 'field-description';
            desc.textContent = schema.description;
            field.appendChild(desc);
        }

        return field;
    }

    renderMultiImagePreviews(fieldName, images, container, hiddenInput) {
        container.innerHTML = '';

        images.forEach((imageUrl, index) => {
            const previewItem = document.createElement('div');
            previewItem.className = 'multi-image-preview-item';

            const img = document.createElement('img');
            img.src = imageUrl;
            img.alt = `Image ${index + 1}`;

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'remove-multi-image';
            removeBtn.innerHTML = '<i class="ph ph-x"></i>';
            removeBtn.title = 'Remove image';

            removeBtn.addEventListener('click', () => {
                const currentImages = JSON.parse(hiddenInput.value || '[]');
                currentImages.splice(index, 1);
                hiddenInput.value = currentImages.length > 0 ? JSON.stringify(currentImages) : '';
                this.renderMultiImagePreviews(fieldName, currentImages, container, hiddenInput);
                if (!this.isRestoring) this.saveEndpointSettings(fieldName);
            });

            const indexBadge = document.createElement('span');
            indexBadge.className = 'image-index-badge';
            indexBadge.textContent = index + 1;

            previewItem.appendChild(img);
            previewItem.appendChild(removeBtn);
            previewItem.appendChild(indexBadge);
            container.appendChild(previewItem);
        });
    }

    async handleMultiFileUpload(file, addImageCallback) {
        if (!file.type.startsWith('image/')) {
            this.showToast('Invalid File', 'Please select an image file', 'warning');
            return;
        }

        try {
            const compressedDataURL = await this.compressImageToUserSize(file);
            addImageCallback(compressedDataURL);
        } catch (error) {
            console.error('File upload error:', error);
            this.showToast('Upload Error', 'Failed to process image file', 'error');
        }
    }

    async pasteImageFromClipboard(callback) {
        try {
            const clipboardItems = await navigator.clipboard.read();

            for (const item of clipboardItems) {
                for (const type of item.types) {
                    if (type.startsWith('image/')) {
                        const blob = await item.getType(type);
                        const file = new File([blob], 'pasted-image.png', { type });
                        const compressedDataURL = await this.compressImageToUserSize(file);
                        callback(compressedDataURL);
                        this.showToast('Success', 'Image pasted from clipboard', 'success');
                        return;
                    }
                }
            }

            this.showToast('No Image', 'No image found in clipboard', 'warning');
        } catch (error) {
            console.error('Clipboard paste error:', error);
            if (error.name === 'NotAllowedError') {
                this.showToast('Permission Denied', 'Please grant clipboard permission', 'error');
            } else {
                this.showToast('Paste Error', 'Failed to paste image from clipboard', 'error');
            }
        }
    }

    createSliderField(name, schema, required, label, field) {
        field.appendChild(label);

        const sliderContainer = document.createElement('div');
        sliderContainer.className = 'slider-container';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = name;
        slider.name = name;
        slider.min = schema.minimum;
        slider.max = schema.maximum;
        slider.value = schema.default || schema.minimum;
        slider.step = schema.multipleOf || (schema.type === 'integer' ? 1 : 0.1);

        const valueInput = document.createElement('input');
        valueInput.type = 'number';
        valueInput.className = 'slider-value-input';
        valueInput.name = name; // Add name attribute for proper syncing
        valueInput.value = slider.value;
        valueInput.min = schema.minimum;
        valueInput.max = schema.maximum;
        valueInput.step = schema.multipleOf || (schema.type === 'integer' ? 1 : 0.01); // More precise step for manual input

        const sliderLabels = document.createElement('div');
        sliderLabels.className = 'slider-labels';
        sliderLabels.innerHTML = `
            <span>${schema.minimum}</span>
            <span>${schema.maximum}</span>
        `;

        // Update input when slider changes
        slider.addEventListener('input', () => {
            valueInput.value = slider.value;
            if (this.debugMode) {
                console.log(`🎚️ Slider ${name} changed: range=${slider.value}, number=${valueInput.value}`);
                // Diagnostic: Check what querySelectorAll sees
                const allInputs = document.querySelectorAll(`input[name="${name}"]`);
                console.log(`   📍 Found ${allInputs.length} inputs with name="${name}":`,
                    Array.from(allInputs).map(i => `${i.type}=${i.value}`).join(', '));
            }
            if (!this.isRestoring) this.saveEndpointSettings(name);
        });

        // Update slider when input changes
        valueInput.addEventListener('input', () => {
            const value = parseFloat(valueInput.value);
            if (!isNaN(value) && value >= schema.minimum && value <= schema.maximum) {
                slider.value = value;
                if (this.debugMode) {
                    console.log(`🔢 Number input ${name} changed: number=${valueInput.value}, range=${slider.value}`);
                }
                if (!this.isRestoring) this.saveEndpointSettings(name);
            }
        });

        // Validate input on blur
        valueInput.addEventListener('blur', () => {
            const value = parseFloat(valueInput.value);
            if (isNaN(value) || value < schema.minimum || value > schema.maximum) {
                valueInput.value = slider.value; // Reset to slider value if invalid
            }
        });

        sliderContainer.appendChild(slider);
        sliderContainer.appendChild(valueInput);
        sliderContainer.appendChild(sliderLabels);

        field.appendChild(sliderContainer);

        if (schema.description) {
            const desc = document.createElement('div');
            desc.className = 'field-description';
            desc.textContent = schema.description;
            field.appendChild(desc);
        }

        return field;
    }

    async handleFileUpload(file, urlInput, uploadArea, preview) {
        if (!file.type.startsWith('image/')) {
            alert('Please select an image file');
            return;
        }

        try {
            // Compress image to user's specified size
            const compressedDataURL = await this.compressImageToUserSize(file);
            urlInput.value = compressedDataURL;
            this.showImagePreview(compressedDataURL, uploadArea, preview);

            // Auto-set custom dimensions based on compressed image size
            this.autoSetImageDimensions(compressedDataURL);

            if (!this.isRestoring) this.saveEndpointSettings('image_url');

        } catch (error) {
            console.error('File upload error:', error);
            alert('Failed to process image file');
        }
    }

    showImagePreview(src, uploadArea, preview) {
        const img = preview.querySelector('img');
        img.src = src;
        uploadArea.classList.add('hidden');
        preview.classList.remove('hidden');
    }

    setupEventListeners() {
        // Save settings before page unload
        window.addEventListener('beforeunload', () => {
            if (this.currentEndpoint) {
                this.performSaveEndpointSettings();
            }
        });

        // Save settings when page becomes hidden (tab switch, minimize)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && this.currentEndpoint) {
                this.performSaveEndpointSettings();
            }
        });

        // Mobile menu collapsible sections
        document.querySelectorAll('.mobile-menu-section.collapsible .section-header').forEach(header => {
            header.addEventListener('click', () => {
                const section = header.parentElement;
                section.classList.toggle('collapsed');
            });
        });

        // API Key modal
        document.getElementById('api-key-btn').addEventListener('click', () => {
            document.getElementById('api-key-input').value = this.apiKey;
            document.getElementById('api-key-modal').classList.remove('hidden');
        });

        document.getElementById('save-api-key').addEventListener('click', () => {
            const key = document.getElementById('api-key-input').value.trim();
            if (!key) {
                this.showToast('Warning', 'API key cannot be empty', 'warning');
                return;
            }
            this.apiKey = key;
            localStorage.setItem('falai_api_key', key);
            document.getElementById('api-key-modal').classList.add('hidden');
            this.showToast('Success', 'API key saved successfully!', 'success');
        });

        document.getElementById('cancel-api-key').addEventListener('click', () => {
            document.getElementById('api-key-modal').classList.add('hidden');
        });


        // Panel tabs are now handled by the gallery class

        // Endpoint dropdown
        document.getElementById('endpoint-dropdown').addEventListener('change', (e) => {
            const endpointId = e.target.value;
            if (endpointId) {
                this.selectEndpoint(endpointId);
                this.updateDeleteButtonVisibility(endpointId);
                // Save last selected endpoint
                localStorage.setItem('falai_last_endpoint', endpointId);
            } else {
                this.clearEndpointSelection();
                this.updateDeleteButtonVisibility(null);
            }
        });

        // Delete endpoint button
        const deleteBtn = document.getElementById('delete-endpoint-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                this.deleteCurrentEndpoint();
            });
        } else {
            console.warn('delete-endpoint-btn element not found');
        }

        // Full-screen viewer controls are now handled by the gallery class

        // Results tab switching
        document.getElementById('images-tab').addEventListener('click', () => {
            this.switchResultsTab('images');
        });

        document.getElementById('json-tab').addEventListener('click', () => {
            this.switchResultsTab('json');
        });

        // Form submission
        document.getElementById('generation-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.generateImage();
        });

        // Cancel generation
        document.getElementById('cancel-btn').addEventListener('click', () => {
            this.cancelGeneration();
        });

        // Debug mode toggle
        document.getElementById('debug-checkbox').addEventListener('change', (e) => {
            this.debugMode = e.target.checked;
            localStorage.setItem('falai_debug_mode', this.debugMode);

            if (this.debugMode) {
                this.logDebug('Debug mode enabled', 'system');
            } else {
                console.log('[SYSTEM] Debug mode disabled');
            }
        });

        // Settings import/export
        document.getElementById('export-settings-btn').addEventListener('click', () => {
            this.exportSettings();
        });

        document.getElementById('import-settings-btn').addEventListener('click', () => {
            document.getElementById('import-file-input').click();
        });

        document.getElementById('import-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.importSettings(file);
                e.target.value = ''; // Reset file input
            }
        });

        // Theme toggles - Removed (System theme only)


        // Reset settings
        const resetBtn = document.getElementById('reset-settings-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.resetSettings());
        }

        const mobileResetBtn = document.getElementById('mobile-reset-settings-btn');
        if (mobileResetBtn) {
            mobileResetBtn.addEventListener('click', () => {
                this.resetSettings();
                this.closeMobileMenu();
            });
        }

        // Clear debug log
        document.getElementById('clear-debug').addEventListener('click', () => {
            document.getElementById('debug-content').innerHTML = '';
        });

        // Custom endpoint modal
        document.getElementById('add-endpoint-btn').addEventListener('click', () => {
            document.getElementById('custom-endpoint-modal').classList.remove('hidden');
        });

        document.getElementById('cancel-custom-endpoint').addEventListener('click', () => {
            this.closeCustomEndpointModal();
        });

        document.getElementById('add-custom-endpoint').addEventListener('click', () => {
            this.addCustomEndpoint();
        });

        // Schema file upload
        const schemaUploadArea = document.getElementById('schema-upload-area');
        const schemaFileInput = document.getElementById('openapi-file');
        const schemaFileInfo = document.getElementById('schema-file-info');
        const schemaFileName = document.getElementById('schema-file-name');
        const schemaRemoveFile = document.getElementById('schema-remove-file');

        schemaUploadArea.addEventListener('click', () => {
            schemaFileInput.click();
        });

        schemaUploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            schemaUploadArea.classList.add('drag-over');
        });

        schemaUploadArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            schemaUploadArea.classList.remove('drag-over');
        });

        schemaUploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            schemaUploadArea.classList.remove('drag-over');
            const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type === 'application/json') {
                this.handleSchemaFileSelection(files[0]);
            }
        });

        schemaFileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleSchemaFileSelection(e.target.files[0]);
            }
        });

        schemaRemoveFile.addEventListener('click', () => {
            this.clearSchemaFileSelection();
        });

        // Close modals on background click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.classList.add('hidden');
            }
            // Fullscreen viewer backdrop click is now handled by gallery class
        });

        // Keyboard navigation for full-screen viewer is now handled by gallery class
        document.addEventListener('keydown', (e) => {
            const mobileMenu = document.getElementById('mobile-menu');

            // Handle Escape key for mobile menu
            if (e.key === 'Escape') {
                // Close mobile menu if it's open
                if (mobileMenu.classList.contains('active')) {
                    this.closeMobileMenu();
                    return;
                }
            }
        });

        // Mobile hamburger menu
        const hamburgerMenu = document.getElementById('hamburger-menu');
        const mobileMenu = document.getElementById('mobile-menu');
        const mobileMenuOverlay = document.getElementById('mobile-menu-overlay');

        hamburgerMenu.addEventListener('click', () => {
            this.toggleMobileMenu();
        });

        mobileMenuOverlay.addEventListener('click', () => {
            this.closeMobileMenu();
        });

        // Mobile menu close button
        const mobileMenuCloseBtn = document.getElementById('mobile-menu-close');
        mobileMenuCloseBtn.addEventListener('click', () => {
            this.closeMobileMenu();
        });

        // Mobile menu control buttons
        document.getElementById('mobile-api-key-btn').addEventListener('click', () => {
            this.closeMobileMenu();
            document.getElementById('api-key-btn').click();
        });

        document.getElementById('mobile-add-endpoint-btn').addEventListener('click', () => {
            this.closeMobileMenu();
            document.getElementById('add-endpoint-btn').click();
        });

        document.getElementById('mobile-export-settings-btn').addEventListener('click', () => {
            this.closeMobileMenu();
            document.getElementById('export-settings-btn').click();
        });

        document.getElementById('mobile-import-settings-btn').addEventListener('click', () => {
            this.closeMobileMenu();
            document.getElementById('import-settings-btn').click();
        });

        // Mobile gallery panel logic
        const mobileGalleryBtn = document.getElementById('mobile-gallery-btn');
        const mobileGallery = document.getElementById('mobile-gallery');
        const mobileGalleryOverlay = document.getElementById('mobile-gallery-overlay');
        const mobileGalleryClose = document.getElementById('mobile-gallery-close');

        if (mobileGalleryBtn && mobileGallery && mobileGalleryOverlay && mobileGalleryClose) {
            mobileGalleryBtn.addEventListener('click', () => {
                this.openMobileGallery();
            });
            mobileGalleryClose.addEventListener('click', () => {
                this.closeMobileGallery();
            });
            mobileGalleryOverlay.addEventListener('click', () => {
                this.closeMobileGallery();
            });
        }

        // Close mobile gallery with Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const mg = document.getElementById('mobile-gallery');
                if (mg && mg.classList.contains('active')) {
                    this.closeMobileGallery();
                }
            }
        });

    }

    toggleMobileMenu() {
        const hamburgerMenu = document.getElementById('hamburger-menu');
        const mobileMenu = document.getElementById('mobile-menu');
        const mobileMenuOverlay = document.getElementById('mobile-menu-overlay');

        const isOpen = hamburgerMenu.classList.contains('active');

        if (isOpen) {
            this.closeMobileMenu();
        } else {
            this.openMobileMenu();
        }
    }

    openMobileMenu() {
        const hamburgerMenu = document.getElementById('hamburger-menu');
        const mobileMenu = document.getElementById('mobile-menu');
        const mobileMenuOverlay = document.getElementById('mobile-menu-overlay');

        hamburgerMenu.classList.add('active');
        mobileMenu.classList.add('active');
        mobileMenuOverlay.classList.add('active');

        // Populate mobile menu with advanced options
        this.populateMobileAdvancedOptions();

        // Prevent body scroll when menu is open
        document.body.style.overflow = 'hidden';
    }

    closeMobileMenu() {
        const hamburgerMenu = document.getElementById('hamburger-menu');
        const mobileMenu = document.getElementById('mobile-menu');
        const mobileMenuOverlay = document.getElementById('mobile-menu-overlay');

        hamburgerMenu.classList.remove('active');
        mobileMenu.classList.remove('active');
        mobileMenuOverlay.classList.remove('active');

        // IMPORTANT: First restore advanced options to desktop view (back into the form)
        // so that collectFormData can find them
        this.restoreDesktopAdvancedOptions();

        // Now save settings (elements are back in the form)
        this.performSaveEndpointSettings();

        // Restore body scroll
        document.body.style.overflow = '';
    }

    openMobileGallery() {
        const galleryPanel = document.getElementById('mobile-gallery');
        const overlay = document.getElementById('mobile-gallery-overlay');
        const countEl = document.getElementById('mobile-gallery-count');
        const content = document.getElementById('mobile-gallery-content');

        if (!galleryPanel || !overlay) return;

        // Populate from gallery savedImages
        if (this.gallery) {
            const images = this.gallery.savedImages || [];
            if (countEl) countEl.textContent = images.length + ' images';
            if (content) {
                content.innerHTML = '';
                if (images.length === 0) {
                    content.innerHTML = '<div style="grid-column:1/-1;padding:1rem;color:#6b7280;text-align:center;">No saved images yet</div>';
                } else {
                    images.forEach((imgData, idx) => {
                        const item = this.gallery.createMobileGalleryItem(imgData, idx);
                        content.appendChild(item);
                    });
                }
            }
        }

        overlay.classList.add('active');
        galleryPanel.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    closeMobileGallery() {
        const galleryPanel = document.getElementById('mobile-gallery');
        const overlay = document.getElementById('mobile-gallery-overlay');
        if (!galleryPanel || !overlay) return;
        overlay.classList.remove('active');
        galleryPanel.classList.remove('active');
        document.body.style.overflow = '';
    }

    populateMobileAdvancedOptions() {
        const mobileContainer = document.getElementById('mobile-advanced-options');
        const advancedContainer = document.querySelector('.advanced-options');

        // Clear existing content
        mobileContainer.innerHTML = '';

        if (!advancedContainer || !this.currentEndpoint) {
            mobileContainer.innerHTML = '<p class="no-options-message">Select an endpoint to see advanced options</p>';
            return;
        }

        // Find the actual content container (the fields inside advanced options)
        const advancedContent = advancedContainer.querySelector('.advanced-options-content');
        if (!advancedContent) {
            mobileContainer.innerHTML = '<p class="no-options-message">No advanced options available</p>';
            return;
        }

        // Move the content instead of cloning to preserve event listeners
        // We will move it back when closing the mobile menu
        while (advancedContent.firstChild) {
            mobileContainer.appendChild(advancedContent.firstChild);
        }

        // Store reference to move back later
        this.desktopAdvancedContent = advancedContent;
    }

    restoreDesktopAdvancedOptions() {
        const mobileContainer = document.getElementById('mobile-advanced-options');
        if (this.desktopAdvancedContent && mobileContainer) {
            while (mobileContainer.firstChild) {
                this.desktopAdvancedContent.appendChild(mobileContainer.firstChild);
            }
        }
    }

    // Get target dimensions from user's image_size setting
    getTargetImageSize() {
        const imageSizeSelect = document.querySelector('select[name="image_size"]');
        if (!imageSizeSelect || !imageSizeSelect.value) {
            return null; // No size specified
        }

        if (imageSizeSelect.value === 'custom') {
            // Get custom dimensions
            const widthInput = document.querySelector('input[name="image_size_width"]');
            const heightInput = document.querySelector('input[name="image_size_height"]');

            if (widthInput && heightInput && widthInput.value && heightInput.value) {
                return {
                    width: parseInt(widthInput.value),
                    height: parseInt(heightInput.value)
                };
            }
            return null;
        } else {
            // Parse preset size (e.g. "1024x1024", "512x768")
            const match = imageSizeSelect.value.match(/(\d+)x(\d+)/);
            if (match) {
                return {
                    width: parseInt(match[1]),
                    height: parseInt(match[2])
                };
            }
        }

        return null;
    }

    // Compress image to user's specified dimensions
    async compressImageToUserSize(file) {
        const targetSize = this.getTargetImageSize();

        // If no target size specified, apply fallback size limit
        let finalTargetSize = targetSize;
        if (!targetSize) {
            // Load image to check its size
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => {
                    const originalWidth = img.naturalWidth;
                    const originalHeight = img.naturalHeight;

                    // Apply fallback limit to prevent 413 errors
                    const maxDimension = 1024;
                    if (originalWidth > maxDimension || originalHeight > maxDimension) {
                        const resizeScale = maxDimension / Math.max(originalWidth, originalHeight);
                        const targetWidth = Math.round(originalWidth * resizeScale);
                        const targetHeight = Math.round(originalHeight * resizeScale);

                        console.log(`⚠️ Image too large! Auto-reducing from ${originalWidth}×${originalHeight} to ${targetWidth}×${targetHeight}`);

                        // Create compressed version
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');

                        canvas.width = targetWidth;
                        canvas.height = targetHeight;

                        // Fill background with black (important for masks)
                        ctx.fillStyle = 'black';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);

                        // Calculate centered position
                        const scale = Math.min(targetWidth / originalWidth, targetHeight / originalHeight);
                        const scaledWidth = originalWidth * scale;
                        const scaledHeight = originalHeight * scale;
                        const offsetX = (targetWidth - scaledWidth) / 2;
                        const offsetY = (targetHeight - scaledHeight) / 2;

                        // Draw scaled image
                        ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

                        // Export as JPEG
                        const compressedDataURL = canvas.toDataURL('image/jpeg', 0.85);
                        resolve(compressedDataURL);
                    } else {
                        // Image is small enough, return as-is
                        const reader = new FileReader();
                        reader.onload = (e) => resolve(e.target.result);
                        reader.readAsDataURL(file);
                    }
                };
                img.src = URL.createObjectURL(file);
            });
        }

        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();

            img.onload = () => {
                const originalWidth = img.naturalWidth;
                const originalHeight = img.naturalHeight;

                // Set canvas to exact target dimensions
                canvas.width = targetSize.width;
                canvas.height = targetSize.height;

                // Calculate scaling to fit target size while maintaining aspect ratio
                const scaleX = targetSize.width / originalWidth;
                const scaleY = targetSize.height / originalHeight;
                const scale = Math.min(scaleX, scaleY); // Fit within target size

                // Calculate centered position
                const scaledWidth = originalWidth * scale;
                const scaledHeight = originalHeight * scale;
                const offsetX = (targetSize.width - scaledWidth) / 2;
                const offsetY = (targetSize.height - scaledHeight) / 2;

                // Fill background with black (important for masks)
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Draw scaled image
                ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

                // Export as JPEG with good quality
                const compressedDataURL = canvas.toDataURL('image/jpeg', 0.85);

                if (this.debugMode) {
                    console.log(`🗜️ Compressed image from ${originalWidth}×${originalHeight} to ${targetSize.width}×${targetSize.height}`);
                }

                resolve(compressedDataURL);
            };

            img.onerror = () => {
                // Fallback to original if compression fails
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.readAsDataURL(file);
            };

            img.src = URL.createObjectURL(file);
        });
    }

    // Compress all images in form data to target size before API submission
    async compressFormImages(formData) {
        const targetSize = this.getTargetImageSize();
        if (!targetSize) {
            console.log('📏 No target size specified, skipping image compression');
            return;
        }

        console.log(`🗜️ Compressing form images to target size: ${targetSize.width}×${targetSize.height}`);

        // Find all image fields in the form data
        const imageFields = [];
        for (const [key, value] of Object.entries(formData)) {
            // Check if it's a base64 image data URL
            if (typeof value === 'string' && this.isBase64DataURL(value)) {
                imageFields.push(key);
            }
        }

        // Compress each image field
        for (const fieldName of imageFields) {
            const originalDataURL = formData[fieldName];
            try {
                const compressedDataURL = await this.compressDataURLToSize(originalDataURL, targetSize);
                formData[fieldName] = compressedDataURL;

                if (this.debugMode) {
                    const originalSize = new Blob([originalDataURL]).size;
                    const compressedSize = new Blob([compressedDataURL]).size;
                    console.log(`🗜️ Compressed ${fieldName}: ${this.formatBytes(originalSize)} → ${this.formatBytes(compressedSize)}`);
                }
            } catch (error) {
                console.warn(`⚠️ Failed to compress ${fieldName}:`, error);
            }
        }
    }

    // Compress a data URL to specific dimensions
    async compressDataURLToSize(dataURL, targetSize) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // Set canvas to target dimensions
                canvas.width = targetSize.width;
                canvas.height = targetSize.height;

                // Calculate scaling to fit within target size while maintaining aspect ratio
                const scaleX = targetSize.width / img.naturalWidth;
                const scaleY = targetSize.height / img.naturalHeight;
                const scale = Math.min(scaleX, scaleY);

                // Calculate centered position
                const scaledWidth = img.naturalWidth * scale;
                const scaledHeight = img.naturalHeight * scale;
                const offsetX = (targetSize.width - scaledWidth) / 2;
                const offsetY = (targetSize.height - scaledHeight) / 2;

                // Fill background with black
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                // Draw scaled image
                ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);

                // Export as JPEG with good quality
                const compressedDataURL = canvas.toDataURL('image/jpeg', 0.85);
                resolve(compressedDataURL);
            };

            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = dataURL;
        });
    }

    isMobileDevice() {
        return window.innerWidth <= 768;
    }

    setupMobileTouchFix(fabricCanvas) {
        console.log('📱 Setting up mobile touch coordinate fix');

        // Force proper offset calculation
        fabricCanvas.calcOffset();

        // Override touch event handling
        const canvas = fabricCanvas.upperCanvasEl;
        const originalTouch = canvas.ontouchstart;

        // Add touch coordinate correction
        fabricCanvas.on('path:created', (e) => {
            if (this.isMobileDevice() && e.path) {
                // Get canvas container for correct offset calculation
                const container = canvas.parentElement;
                const containerRect = container.getBoundingClientRect();
                const canvasRect = canvas.getBoundingClientRect();

                // Calculate any offset due to container positioning
                const offsetX = canvasRect.left - containerRect.left;
                const offsetY = canvasRect.top - containerRect.top;

                console.log('🖱️ Touch offset compensation:', offsetX, offsetY);
            }
        });

        // Recalculate offset after any resize or change
        const observer = new ResizeObserver(() => {
            fabricCanvas.calcOffset();
        });
        observer.observe(canvas.parentElement);
    }

    fixMobileTouchCoordinates(fabricCanvas) {
        // Override the _getPointer method to fix touch coordinates on mobile
        const originalGetPointer = fabricCanvas._getPointer;

        if (!originalGetPointer || typeof originalGetPointer !== 'function') {
            console.warn('[WARNING] Original _getPointer method not found, skipping touch coordinate fix');
            return;
        }

        fabricCanvas._getPointer = function (e, ignoreZoom) {
            // Use the original method as base
            const pointer = originalGetPointer.call(this, e, ignoreZoom);

            // For touch events, we need to recalculate coordinates
            if (e.touches || e.changedTouches) {
                const canvasElement = this.upperCanvasEl;
                const rect = canvasElement.getBoundingClientRect();
                const touch = e.touches?.[0] || e.changedTouches?.[0];

                if (touch) {
                    // Calculate correct touch coordinates relative to canvas
                    const scaleX = canvasElement.width / rect.width;
                    const scaleY = canvasElement.height / rect.height;

                    pointer.x = (touch.clientX - rect.left) * scaleX;
                    pointer.y = (touch.clientY - rect.top) * scaleY;
                }
            }

            return pointer;
        };

        // Also fix the getPointer method for public API
        const originalPublicGetPointer = fabricCanvas.getPointer;
        fabricCanvas.getPointer = function (e, ignoreZoom) {
            if (e.touches || e.changedTouches) {
                return this._getPointer(e, ignoreZoom);
            }
            return originalPublicGetPointer.call(this, e, ignoreZoom);
        };

        // Force canvas to recalculate offset on touch start
        fabricCanvas.on('mouse:down', function () {
            this.calcOffset();
        });

        // Additional fix for retina displays
        if (window.devicePixelRatio > 1) {
            const canvas = fabricCanvas.upperCanvasEl;
            const context = canvas.getContext('2d');

            // Scale the drawing context for retina
            const pixelRatio = window.devicePixelRatio;
            canvas.width = canvas.offsetWidth * pixelRatio;
            canvas.height = canvas.offsetHeight * pixelRatio;
            context.scale(pixelRatio, pixelRatio);
            canvas.style.width = canvas.offsetWidth + 'px';
            canvas.style.height = canvas.offsetHeight + 'px';
        }

        console.log('✅ Mobile touch coordinates fixed for mask editor');
    }

    // Background & Notification Support
    async requestNotificationPermission() {
        if (!('Notification' in window)) {
            console.warn('Notifications not supported in this browser');
            return false;
        }

        // Check for secure context (HTTPS or localhost)
        if (!window.isSecureContext) {
            this.showToast('Warning', 'Notifications require HTTPS', 'warning');
            console.warn('Notifications require a secure context (HTTPS)');
            return false;
        }

        if (Notification.permission === 'granted') return true;

        if (Notification.permission !== 'denied') {
            try {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    this.showToast('Success', 'Notifications enabled!', 'success');
                    // Test notification immediately
                    this.sendSystemNotification('FalAI Ready', 'Notifications are working correctly.');
                    return true;
                }
            } catch (e) {
                console.warn('Permission request failed', e);
            }
        }
        return false;
    }

sendSystemNotification(title, body, type = 'info') {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;

        // On mobile, we might want to show notification even if visible,
        // to confirm background processing is working.
        const isProgress = type === 'progress';
        const isComplete = type === 'success';

        // Skip if visible AND it's just a generic info message (not progress/complete)
        if (document.visibilityState === 'visible' && !isComplete && !isProgress && !this.debugMode) return;

        try {
            const options = {
                body: body,
                icon: 'favicon192.png',
                badge: 'favicon.png',
                vibrate: isComplete ? [200, 100, 200] : undefined,
                tag: 'falai-generation', // Same tag replaces previous notification
                renotify: isComplete, // Vibrate/Sound again only on completion
                silent: isProgress, // Progress updates should be silent
                ongoing: isProgress, // Android: makes notification persistent/un-dismissable while running
                requireInteraction: isComplete // Desktop: keep on screen until clicked
            };

            // Try Service Worker notification first (better for mobile)
            if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                navigator.serviceWorker.ready.then(registration => {
                    registration.showNotification(title, options);
                });
            } else {
                // Fallback to standard Notification API
                new Notification(title, options);
            }
        } catch (e) {
            console.warn('Notification failed:', e);
        }
    }

    async requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake Lock active');
            } catch (err) {
                console.warn(`Wake Lock failed: ${err.name}, ${err.message}`);
            }
        }
    }

    async releaseWakeLock() {
        if (this.wakeLock) {
            try {
                await this.wakeLock.release();
                this.wakeLock = null;
                console.log('Wake Lock released');
            } catch (err) {
                console.warn(`Wake Lock release failed: ${err.name}, ${err.message}`);
            }
        }
    }

    async generateImage() {
        if (!this.apiKey) {
            this.showError('Please set your API key first. Click "Set API Key" in the menu.');
            return;
        }

        if (!this.currentEndpoint) {
            this.showError('Please select an endpoint first.');
            return;
        }

        // Request notification permission and wake lock
        this.requestNotificationPermission();
        this.requestWakeLock();

        // Save settings before generating (ensures desktop changes are persisted)
        this.performSaveEndpointSettings();

        // Collect form data
        const formData = this.collectFormData();

        // Compress all images to target size before sending to API
        await this.compressFormImages(formData);

        // Filter out LoRAs with weight 0 before sending request
        this.filterLoRAs(formData);

        try {
            // Update button state
            const generateBtn = document.querySelector('.generate-btn');
            const generateText = generateBtn.querySelector('.generate-text');
            const generateLoading = generateBtn.querySelector('.generate-loading');

            generateBtn.classList.add('loading');
            generateText.classList.add('hidden');
            generateLoading.classList.remove('hidden');

            // Show status
            this.showGenerationStatus('Submitting request...');
            this.sendSystemNotification('FalAI Generating...', 'Your request is processing...', 'progress');

            // Submit to queue
            const queueResponse = await this.submitToQueue(formData);

            // Check if response already contains results (synchronous response)
            if (queueResponse.images || queueResponse.image || queueResponse.video || queueResponse.output || queueResponse.text || queueResponse.outputs) {
                // Direct response with results
                this.displayResults(queueResponse);
                this.hideGenerationStatus();
                this.resetGenerateButton();
                return;
            }

            // Asynchronous response - need to poll
            this.currentRequestId = queueResponse.request_id;
            this.statusUrl = queueResponse.status_url;
            this.resultUrl = queueResponse.response_url;

            // Save generation state for recovery
            this.saveGenerationState({
                requestId: this.currentRequestId,
                statusUrl: this.statusUrl,
                resultUrl: this.resultUrl,
                endpointId: this.currentEndpointId,
                timestamp: Date.now()
            });

            // Start polling
            this.startStatusPolling();

        } catch (error) {
            console.error('Generation error:', error);
            this.showError('Generation failed: ' + error.message);
            this.resetGenerateButton();
            this.releaseWakeLock(); // Release wake lock on error
        }
    }

    resetGenerateButton() {
        const generateBtn = document.querySelector('.generate-btn');
        const generateText = generateBtn.querySelector('.generate-text');
        const generateLoading = generateBtn.querySelector('.generate-loading');

        generateBtn.classList.remove('loading');
        generateText.classList.remove('hidden');
        generateLoading.classList.add('hidden');

        // Clear saved generation state when generation finishes
        this.clearGenerationState();
    }

    collectFormData() {
        const form = document.getElementById('generation-form');
        const data = {};

        // Get all form inputs
        const inputs = form.querySelectorAll('input, select, textarea');

        // Track which keys we've seen from range inputs (to avoid number input overwriting)
        const rangeKeys = new Set();

        inputs.forEach(input => {
            const key = input.name;
            if (!key) return;

            // Handle array fields (like loras[0].path)
            if (key.includes('[') && key.includes(']')) {
                const value = this.getInputValue(input);
                this.setNestedProperty(data, key, value);
                return;
            }

            // Skip custom size fields - they'll be handled by image_size logic
            if (key.includes('_width') || key.includes('_height')) {
                return;
            }

            if (input.type === 'checkbox') {
                data[key] = input.checked;
            } else if (input.type === 'range') {
                // Range input - mark this key and save value
                rangeKeys.add(key);
                const value = input.value;
                if (value !== '') {
                    data[key] = parseFloat(value);
                }
            } else if (input.type === 'number') {
                // Number input - skip if we already have value from range slider
                if (rangeKeys.has(key)) {
                    return; // Skip - range value is authoritative
                }
                const value = input.value;
                if (value !== '') {
                    data[key] = parseFloat(value);
                }
            } else if (input.tagName === 'SELECT') {
                const value = this.getInputValue(input);
                if (value !== undefined) {
                    data[key] = value;
                }
            } else if (input.value !== '') {
                data[key] = input.value;
            }
        });

        // Handle fields that should be arrays according to schema (e.g., image_urls)
        // Parse JSON arrays from hidden inputs or wrap single strings in arrays
        for (const key of Object.keys(data)) {
            const schema = this.getFieldSchema(key);
            if (schema && schema.type === 'array') {
                const value = data[key];
                if (typeof value === 'string') {
                    // Try to parse as JSON array first (from multi-image upload)
                    if (value.startsWith('[')) {
                        try {
                            data[key] = JSON.parse(value);
                        } catch {
                            data[key] = [value];
                        }
                    } else if (value) {
                        // Single string value - wrap in array
                        data[key] = [value];
                    } else {
                        // Empty string - remove the field
                        delete data[key];
                    }
                }
            }
        }

        // Special handling for image_size field
        this.handleImageSizeData(data, form);

        // Merge with existing settings to preserve fields that might be temporarily hidden or missing
        if (this.currentEndpoint && this.endpointSettings[this.currentEndpoint.metadata.endpointId]) {
            const existing = this.endpointSettings[this.currentEndpoint.metadata.endpointId];
            for (const [key, value] of Object.entries(existing)) {
                // Only merge if key is missing from current data
                if (!(key in data) && key !== 'image_size') {
                    // CRITICAL FIX: Do NOT restore array fields (like 'loras') from history.
                    // If an array field is missing from 'data', it means the user deleted all items.
                    // Restoring it from 'existing' would bring back the deleted items ("zombie" bug).
                    const schema = this.getFieldSchema(key);
                    if (schema && schema.type === 'array') {
                        // EXTRA SAFETY: Only skip merging if the array container actually exists in the DOM.
                        // If the container exists but we found no data, it means the user deleted the items.
                        // If the container does NOT exist, the UI might not be rendered, so we should preserve the data.
                        const container = form.querySelector(`#${key}-items`);
                        if (container) {
                            continue;
                        }
                    }

                    data[key] = value;
                }
            }
        }

        return data;
    }

    handleImageSizeData(data, form) {
        // Try to find by name first, then by ID
        const imageSizeSelect = form.querySelector('select[name="image_size"]') || document.getElementById('image_size');

        // If select is not found, check if we have saved data to preserve
        if (!imageSizeSelect) {
            if (this.currentEndpoint && this.endpointSettings[this.currentEndpoint.metadata.endpointId]?.image_size) {
                data.image_size = this.endpointSettings[this.currentEndpoint.metadata.endpointId].image_size;
            }
            return;
        }

        if (!imageSizeSelect.value) {
            if (this.debugMode) console.warn('handleImageSizeData: Select has no value');
            return;
        }

        if (imageSizeSelect.value === 'custom') {
            // Use custom width/height values
            const widthInput = form.querySelector('input[name="image_size_width"]') || document.getElementById('image_size_width');
            const heightInput = form.querySelector('input[name="image_size_height"]') || document.getElementById('image_size_height');

            if (widthInput && heightInput && widthInput.value && heightInput.value) {
                data.image_size = {
                    width: parseInt(widthInput.value),
                    height: parseInt(heightInput.value)
                };
            }
        } else {
            // Use preset size
            data.image_size = imageSizeSelect.value;
        }
    }

    autoSetImageDimensions(imageUrl) {
        // Create an image element to get dimensions
        const img = new Image();

        img.onload = () => {
            const width = img.naturalWidth;
            const height = img.naturalHeight;

            // Only set dimensions if we got valid values
            if (width > 0 && height > 0) {
                // Find image_size select and custom dimension inputs
                const imageSizeSelect = document.querySelector('select[name="image_size"]');
                const widthInput = document.querySelector('input[name="image_size_width"]');
                const heightInput = document.querySelector('input[name="image_size_height"]');

                if (imageSizeSelect && widthInput && heightInput) {
                    // Set to custom mode
                    imageSizeSelect.value = 'custom';
                    // Show custom fields first
                    imageSizeSelect.dispatchEvent(new Event('change', { bubbles: true }));

                    // Set original dimensions in the scale control
                    const container = imageSizeSelect.closest('.image-size-container');
                    if (container && container.setOriginalDimensions) {
                        container.setOriginalDimensions(width, height);
                    }

                    // Set width and height to match the uploaded image (scale 1:1 initially)
                    widthInput.value = width;
                    heightInput.value = height;

                    // Reset scale to 100%
                    const scaleInput = document.querySelector('input[name="image_size_scale"]');
                    const scaleValue = document.querySelector('.scale-value');
                    if (scaleInput && scaleValue) {
                        scaleInput.value = '1';
                        scaleValue.textContent = '100%';
                    }

                    // Trigger input events to save settings
                    widthInput.dispatchEvent(new Event('input', { bubbles: true }));
                    heightInput.dispatchEvent(new Event('input', { bubbles: true }));

                    if (this.debugMode) {
                        console.log(`✅ Auto-set image dimensions: ${width}x${height} (with scale controls)`);
                    }
                }
            }
        };

        img.onerror = () => {
            if (this.debugMode) {
                console.warn('[WARNING] Could not determine image dimensions - image failed to load');
            }
        };

        // Set crossOrigin for external URLs (may help with CORS)
        if (!imageUrl.startsWith('data:')) {
            img.crossOrigin = 'anonymous';
        }

        img.src = imageUrl;
    }

    getInputValue(input) {
        if (input.type === 'checkbox') {
            return input.checked;
        } else if (input.type === 'number' || input.type === 'range') {
            const value = input.value;
            return value !== '' ? parseFloat(value) : undefined;
        } else if (input.tagName === 'SELECT') {
            const value = input.value;
            if (value === '') return undefined;

            const selectedOption = input.selectedOptions?.[0];
            const valueType = selectedOption?.dataset?.valueType;

            if (valueType === 'number') {
                return parseFloat(value);
            }

            if (valueType === 'boolean') {
                return value === 'true';
            }

            return value;
        } else {
            return input.value !== '' ? input.value : undefined;
        }
    }

    setNestedProperty(obj, path, value) {
        if (value === undefined) return;

        // Parse path like "loras[0].path" into ["loras", 0, "path"]
        const parts = path.split(/[\[\].]/).filter(part => part !== '');
        let current = obj;

        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const nextPart = parts[i + 1];

            if (!current[part]) {
                // Create array if next part is a number, otherwise create object
                current[part] = !isNaN(parseInt(nextPart)) ? [] : {};
            }

            current = current[part];
        }

        const lastPart = parts[parts.length - 1];
        current[lastPart] = value;
    }

    filterLoRAs(data) {
        // Filter out LoRAs with weight 0 from the request
        if (data.loras && Array.isArray(data.loras)) {
            if (this.debugMode) {
                console.log('[SEARCH] LoRA data before filtering:', JSON.stringify(data.loras, null, 2));
            }

            data.loras = data.loras.filter(lora => {
                // Keep LoRA if it has a valid path and scale is not exactly 0
                const hasPath = lora && lora.path && lora.path.trim() !== '';
                const scaleValue = lora && (lora.scale !== undefined ? lora.scale : lora.weight);
                const hasValidScale = scaleValue !== undefined && scaleValue !== null && scaleValue !== 0;

                if (this.debugMode) {
                    console.log(`🔍 LoRA "${lora?.path}": path=${hasPath}, scale=${scaleValue}, valid=${hasValidScale}`);
                }

                if (this.debugMode && lora && hasPath && !hasValidScale) {
                    console.log(`🚫 Filtering out LoRA "${lora.path}" with scale ${scaleValue} (should be !== 0)`);
                }

                return hasPath && hasValidScale;
            });

            // Remove loras field completely if empty
            if (data.loras.length === 0) {
                delete data.loras;
            }
        }
    }

    async submitToQueue(data) {
        const endpoint = this.currentEndpoint;
        const baseUrl = endpoint.schema.servers[0].url;
        const endpointPath = this.getSubmissionPath(endpoint.schema);
        const fullUrl = baseUrl + endpointPath;

        this.logDebug('Submitting request to queue', 'request', {
            url: fullUrl,
            endpoint: endpoint.metadata.endpointId,
            method: 'POST',
            headers: {
                'Authorization': 'Key [HIDDEN]',
                'Content-Type': 'application/json'
            },
            body: data
        });

        const response = await fetch(fullUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Key ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const error = await response.text();
            this.logDebug('Request failed', 'error', {
                status: response.status,
                statusText: response.statusText,
                error: error
            });
            throw new Error(`HTTP ${response.status}: ${error}`);
        }

        const result = await response.json();
        this.logDebug('Request submitted successfully', 'response', result);

        return result;
    }

    getSubmissionPath(schema) {
        for (const [path, methods] of Object.entries(schema.paths)) {
            if (methods.post && methods.post.requestBody) {
                return path;
            }
        }
        throw new Error('No submission endpoint found');
    }

    startStatusPolling() {
        if (this.statusPolling) {
            clearInterval(this.statusPolling);
        }

        this.statusPolling = setInterval(async () => {
            try {
                await this.checkStatus();
            } catch (error) {
                console.error('Status check failed:', error);
                clearInterval(this.statusPolling);
                this.showError('Status check failed: ' + error.message);
            }
        }, 2000);
    }

    async checkStatus() {
        if (!this.statusUrl) return;

        const response = await fetch(this.statusUrl, {
            headers: {
                'Authorization': `Key ${this.apiKey}`
            }
        });

        if (!response.ok) {
            // If status endpoint returns 404 or 405, the job might be completed
            // Try to fetch results directly
            if (response.status === 404 || response.status === 405) {
                this.logDebug('Status endpoint not available, trying to fetch results directly', 'info', {
                    status: response.status,
                    statusText: response.statusText
                });
                clearInterval(this.statusPolling);
                await this.fetchResults();
                this.resetGenerateButton();
                return;
            }

            this.logDebug('Status check failed', 'error', {
                status: response.status,
                statusText: response.statusText
            });
            throw new Error(`Status check failed: ${response.status}`);
        }

        const status = await response.json();
        this.logDebug('Status response', 'response', status);
        this.updateStatusDisplay(status);

        if (status.status === 'COMPLETED') {
            clearInterval(this.statusPolling);
            await this.fetchResults();
            this.resetGenerateButton();
        } else if (status.status === 'FAILED') {
            clearInterval(this.statusPolling);
            this.showError('Generation failed');
            this.resetGenerateButton();
        }
    }

    getStatusPath(schema, requestId) {
        for (const [path, methods] of Object.entries(schema.paths)) {
            if (path.includes('/status') && methods.get) {
                return path.replace('{request_id}', requestId);
            }
        }
        throw new Error('No status endpoint found');
    }

    updateStatusDisplay(status) {
        const statusMessage = document.getElementById('status-message');
        const progressFill = document.getElementById('progress-fill');

        // Update message based on status
        let message = '';
        let progress = 0;

        if (status.status === 'IN_PROGRESS') {
            if (status.percentage !== undefined) {
                message = `Processing... ${Math.round(status.percentage)}%`;
                progress = status.percentage;
            } else {
                message = 'Processing your request...';
                progress = 25; // Default progress for processing
            }
        } else if (status.status === 'IN_QUEUE') {
            if (status.queue_position !== undefined) {
                message = `In queue (position ${status.queue_position})`;
                progress = 10;
            } else {
                message = 'Waiting in queue...';
                progress = 5;
            }
        } else if (status.status === 'COMPLETED') {
            message = 'Generation completed successfully!';
            progress = 100;
        } else {
            message = status.status.toLowerCase().replace('_', ' ');
            progress = 15;
        }

        statusMessage.textContent = message;
        progressFill.style.width = `${progress}%`;

        this.logDebug('Status updated', 'status', { status: status.status, progress, message });
    }

    async fetchResults() {
        if (!this.resultUrl) return;

        const response = await fetch(this.resultUrl, {
            headers: {
                'Authorization': `Key ${this.apiKey}`
            }
        });

        if (!response.ok) {
            this.logDebug('Result fetch failed', 'error', {
                status: response.status,
                statusText: response.statusText
            });
            throw new Error(`Result fetch failed: ${response.status}`);
        }

        const result = await response.json();
        this.logDebug('Results fetched successfully', 'response', result);

        this.displayResults(result);
        this.hideGenerationStatus();
    }

    getResultPath(schema, requestId) {
        for (const [path, methods] of Object.entries(schema.paths)) {
            if (path.includes('/{request_id}') && !path.includes('/status') && !path.includes('/cancel') && methods.get) {
                return path.replace('{request_id}', requestId);
            }
        }
        throw new Error('No result endpoint found');
    }

    displayResults(result) {
        // Release wake lock as generation is done
        this.releaseWakeLock();

        const container = document.getElementById('result-images');
        container.innerHTML = '';

        // Store result for JSON display
        this.lastResult = result;

        // Send notification if backgrounded
        this.sendSystemNotification('Generation Complete', 'Your image is ready!', 'success');

        const imageResults = Array.isArray(result.images)
            ? result.images
            : (result.image && result.image.url ? [result.image] : []);

        // Handle different result types: images, video, or text
        if (imageResults.length > 0) {
            // Image generation results
            const added = [];
            for (const image of imageResults) {
                const imageElement = this.createImageElement(image, result);
                container.appendChild(imageElement);
                // Auto-save silently (dedupe) so gallery always has generations
                // Use prompt from API result if available, otherwise fall back to form input
                const promptFromResult = result.prompt || image.prompt || (document.getElementById('prompt')?.value || '').trim();
                const meta = {
                    endpoint: this.currentEndpoint?.metadata?.endpointId || 'Unknown',
                    parameters: this.lastUsedParams || {},
                    seed: result.seed || image.seed || '',
                    prompt: promptFromResult,
                    // Store complete API response data for metadata recovery
                    request_id: this.currentRequestId,
                    api_response: {
                        ...result, // Full result from API
                        image_data: image, // Individual image data
                        generation_timestamp: Date.now(),
                        api_endpoint: this.currentEndpoint?.metadata?.endpointId,
                        form_params: { ...this.lastUsedParams } // Copy of form parameters
                    }
                };
                if (this.gallery.saveImage(image.url, meta, { dedupe: true, silent: true })) {
                    added.push(image.url);
                }
            }
            if (added.length && this.showNotification) {
                this.showNotification(`${added.length} image${added.length>1?'s':''} added to gallery`, 'success');
            }

            // Update JSON display
            this.updateJsonDisplay(result);

            // Switch to results view and show results
            this.gallery.switchRightPanelView('results');
            document.getElementById('no-images-placeholder').classList.add('hidden');
            document.getElementById('results').classList.remove('hidden');
            this.switchResultsTab('images');
        } else if (result.video && result.video.url) {
            // Video generation results
            const videoElement = this.createVideoElement(result.video, result);
            container.appendChild(videoElement);

            // Save video to gallery
            const promptFromResult = result.prompt || (document.getElementById('prompt')?.value || '').trim();
            const meta = {
                endpoint: this.currentEndpoint?.metadata?.endpointId || 'Unknown',
                parameters: this.lastUsedParams || {},
                seed: result.seed || '',
                prompt: promptFromResult,
                type: 'video',
                request_id: this.currentRequestId,
                api_response: {
                    ...result,
                    generation_timestamp: Date.now(),
                    api_endpoint: this.currentEndpoint?.metadata?.endpointId,
                    form_params: { ...this.lastUsedParams }
                }
            };
            if (this.gallery.saveImage(result.video.url, meta, { dedupe: true, silent: true })) {
                if (this.showNotification) {
                    this.showNotification('Video added to gallery', 'success');
                }
            }

            // Update JSON display
            this.updateJsonDisplay(result);

            // Switch to results view and show results
            this.gallery.switchRightPanelView('results');
            document.getElementById('no-images-placeholder').classList.add('hidden');
            document.getElementById('results').classList.remove('hidden');
            this.switchResultsTab('images');
        } else if (result.output) {
            // Text generation results (fal-ai/any-llm)
            const textElement = this.createTextElement(result.output, result);
            container.appendChild(textElement);
        } else if (result.text) {
            // Text analysis results (fal-ai/bagel/understand)
            const textElement = this.createTextElement(result.text, result);
            container.appendChild(textElement);
        } else if (result.outputs && Array.isArray(result.outputs)) {
            // Batch processing results (fal-ai/moondream-next/batch)
            const batchElement = this.createBatchTextElement(result.outputs, result);
            container.appendChild(batchElement);

            // Update JSON display
            this.updateJsonDisplay(result);

            // Switch to results view and show results
            this.gallery.switchRightPanelView('results');
            document.getElementById('no-images-placeholder').classList.add('hidden');
            document.getElementById('results').classList.remove('hidden');
            this.switchResultsTab('images');
        } else {
            // Unknown result format - just show JSON
            this.updateJsonDisplay(result);
            this.gallery.switchRightPanelView('results');
            document.getElementById('no-images-placeholder').classList.add('hidden');
            document.getElementById('results').classList.remove('hidden');
            this.switchResultsTab('json');
        }
    }

    switchResultsTab(tab) {
        const imagesTab = document.getElementById('images-tab');
        const jsonTab = document.getElementById('json-tab');
        const imagesContent = document.getElementById('result-images');
        const jsonContent = document.getElementById('result-json');

        if (tab === 'images') {
            imagesTab.classList.add('active');
            jsonTab.classList.remove('active');
            imagesContent.classList.remove('hidden');
            jsonContent.classList.add('hidden');
        } else {
            jsonTab.classList.add('active');
            imagesTab.classList.remove('active');
            jsonContent.classList.remove('hidden');
            imagesContent.classList.add('hidden');
        }
    }

    updateJsonDisplay(result) {
        const jsonOutput = document.getElementById('json-output');
        jsonOutput.textContent = JSON.stringify(result, null, 2);
    }

    createImageElement(image, metadata = {}) {
    // Use gallery method (PhotoSwipe-compatible anchor)
        const endpointId = this.currentEndpoint?.metadata?.endpointId;
        const hasParams = this.lastUsedParams && Object.keys(this.lastUsedParams).length > 0;
        // Use prompt from API result if available, otherwise fall back to form input
        const promptFromResult = metadata.prompt || image.prompt || (document.getElementById('prompt')?.value || '').trim();
        // Store only minimal metadata needed for gallery (avoid entire result object duplication per image)
        const imageMetadata = {
            endpoint: endpointId || 'Unknown',
            ...(hasParams ? { parameters: this.lastUsedParams } : {}),
            seed: metadata.seed || image.seed || '',
            prompt: promptFromResult
        };

        return this.gallery.createResultImageItem(image.url, imageMetadata);
    }

    createVideoElement(video, metadata = {}) {
        const videoDiv = document.createElement('div');
        videoDiv.className = 'result-video-item';

        const videoElement = document.createElement('video');
        videoElement.src = video.url;
        videoElement.controls = true;
        videoElement.className = 'result-video';
        videoElement.style.maxWidth = '100%';
        videoElement.style.height = 'auto';

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'result-actions';

        const downloadBtn = document.createElement('button');
        downloadBtn.innerHTML = '<i class="ph ph-download-simple"></i> Download';
        downloadBtn.className = 'btn secondary small';
        downloadBtn.onclick = () => this.downloadMedia(video.url, 'video');

        actionsDiv.appendChild(downloadBtn);
        videoDiv.appendChild(videoElement);
        videoDiv.appendChild(actionsDiv);

        return videoDiv;
    }

    createTextElement(text, metadata = {}) {
        const textDiv = document.createElement('div');
        textDiv.className = 'result-text-item';

        const textContent = document.createElement('div');
        textContent.className = 'result-text-content';
        textContent.style.cssText = `
            background: var(--surface-color);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 1rem;
            margin-bottom: 1rem;
            font-family: var(--font-mono);
            line-height: 1.5;
            white-space: pre-wrap;
            word-wrap: break-word;
        `;

        // Handle reasoning if available
        if (metadata.reasoning) {
            const reasoningSection = document.createElement('div');
            reasoningSection.innerHTML = `<strong>Reasoning:</strong><br>${metadata.reasoning}`;
            reasoningSection.style.cssText = `
                margin-bottom: 1rem;
                padding-bottom: 1rem;
                border-bottom: 1px solid var(--border-color);
                color: var(--text-secondary);
            `;
            textContent.appendChild(reasoningSection);
        }

        const outputSection = document.createElement('div');
        outputSection.innerHTML = `<strong>Output:</strong><br>${text}`;
        textContent.appendChild(outputSection);

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'result-actions';

        const copyBtn = document.createElement('button');
        copyBtn.innerHTML = '<i class="ph ph-copy"></i> Copy';
        copyBtn.className = 'btn secondary small';
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(text).then(() => {
                if (this.showNotification) {
                    this.showNotification('Text copied to clipboard', 'success');
                }
            });
        };

        actionsDiv.appendChild(copyBtn);
        textDiv.appendChild(textContent);
        textDiv.appendChild(actionsDiv);

        return textDiv;
    }

    createBatchTextElement(outputs, metadata = {}) {
        const batchDiv = document.createElement('div');
        batchDiv.className = 'result-batch-text-item';

        const batchContent = document.createElement('div');
        batchContent.className = 'result-batch-text-content';
        batchContent.style.cssText = `
            background: var(--surface-color);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 1rem;
            margin-bottom: 1rem;
            font-family: var(--font-mono);
            line-height: 1.5;
        `;

        const header = document.createElement('div');
        header.innerHTML = `<strong>Batch Results (${outputs.length} items):</strong>`;
        header.style.cssText = `
            margin-bottom: 1rem;
            padding-bottom: 0.5rem;
            border-bottom: 1px solid var(--border-color);
            color: var(--text-primary);
        `;
        batchContent.appendChild(header);

        // Create numbered list of outputs
        outputs.forEach((output, index) => {
            const outputItem = document.createElement('div');
            outputItem.style.cssText = `
                margin-bottom: 0.75rem;
                padding: 0.5rem;
                background: rgba(var(--primary-rgb), 0.1);
                border-radius: 4px;
                border-left: 3px solid var(--primary-color);
            `;
            outputItem.innerHTML = `<strong>${index + 1}.</strong> ${output}`;
            batchContent.appendChild(outputItem);
        });

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'result-actions';

        const copyAllBtn = document.createElement('button');
        copyAllBtn.innerHTML = '<i class="ph ph-copy"></i> Copy All';
        copyAllBtn.className = 'btn secondary small';
        copyAllBtn.onclick = () => {
            const allText = outputs.map((output, index) => `${index + 1}. ${output}`).join('\n');
            navigator.clipboard.writeText(allText).then(() => {
                if (this.showNotification) {
                    this.showNotification('All results copied to clipboard', 'success');
                }
            });
        };

        // Add download file button if captions_file is available
        if (metadata.captions_file && metadata.captions_file.url) {
            const downloadFileBtn = document.createElement('button');
            downloadFileBtn.innerHTML = '<i class="ph ph-download-simple"></i> Download File';
            downloadFileBtn.className = 'btn secondary small';
            downloadFileBtn.onclick = () => this.downloadMedia(metadata.captions_file.url, 'captions.json');
            actionsDiv.appendChild(downloadFileBtn);
        }

        actionsDiv.appendChild(copyAllBtn);
        batchDiv.appendChild(batchContent);
        batchDiv.appendChild(actionsDiv);

        return batchDiv;
    }

    downloadMedia(url, type = 'image') {
        const link = document.createElement('a');
        link.href = url;
        link.download = `falai_${type}_${Date.now()}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    resetFormToDefaults() {
        if (!this.currentEndpoint) return;
        // Scope only to current endpoint form fields container
        const form = document.getElementById('generation-form');
        if (!form) return;

        // Derive input schema using existing logic
        const inputSchema = this.getInputSchema(this.currentEndpoint.schema) || this.findInputSchema(this.currentEndpoint.schema);
        if (!inputSchema || !inputSchema.properties) return;

        // Only process direct children inside #form-fields (current endpoint generated UI)
        const fieldContainer = document.getElementById('form-fields');
        if (!fieldContainer) return;

        const scopedInputs = fieldContainer.querySelectorAll('input, select, textarea');

        // Clear array containers inside this scope
        fieldContainer.querySelectorAll('.array-items').forEach(container => {
            container.innerHTML = '';
        });

        // Reset simple fields
        scopedInputs.forEach(input => {
            const fieldName = input.name;
            if (!fieldName) return;
            if (fieldName.includes('[') && fieldName.includes(']')) return; // arrays later

            let fieldSchema = inputSchema.properties[fieldName];
            if (!fieldSchema) return;

            if (fieldSchema.anyOf && fieldSchema.anyOf.length > 0) {
                const enumSchema = fieldSchema.anyOf.find(option => option.enum);
                if (enumSchema) {
                    fieldSchema = { ...fieldSchema, enum: enumSchema.enum, default: fieldSchema.default };
                } else {
                    fieldSchema = { ...fieldSchema, ...fieldSchema.anyOf[0] };
                }
            }

            this.setFieldToDefault(input, fieldSchema);
        });

        // Rebuild array defaults
        Object.entries(inputSchema.properties).forEach(([fieldName, fieldSchema]) => {
            if (fieldSchema.type === 'array') {
                const container = fieldContainer.querySelector(`#${fieldName}-items`);
                if (container && fieldSchema.default && Array.isArray(fieldSchema.default)) {
                    fieldSchema.default.forEach(() => {
                        this.addArrayItem(fieldName, fieldSchema, container);
                    });
                }
            }
        });

        // Persist updated (reset) settings only for this endpoint id
        this.saveEndpointSettings();
    }

    setFieldToDefault(input, schema) {
        if (schema.default === undefined) {
            // Clear the field if no default
            if (input.type === 'checkbox') {
                input.checked = false;
            } else {
                input.value = '';
            }
            return;
        }

        if (input.type === 'checkbox') {
            input.checked = Boolean(schema.default);
        } else if (input.type === 'range' || input.type === 'number') {
            input.value = schema.default;
            // Update slider display if it exists
            const valueDisplay = input.parentElement.querySelector('.slider-value');
            if (valueDisplay) {
                valueDisplay.textContent = schema.default;
            }
        } else {
            input.value = schema.default;
        }
    }

    createImageSizeField(name, schema, required, label, field) {
        const container = document.createElement('div');
        container.className = 'image-size-container';

        // Get the ImageSize schema from anyOf to check if custom sizes are supported
        const imageSizeSchema = this.getImageSizeSchemaFromAnyOf(schema);
        const supportsCustomSize = imageSizeSchema !== null;

        // Create select dropdown with preset options
        const select = document.createElement('select');
        select.name = name;
        select.id = name;
        select.className = 'image-size-select';
        select.innerHTML = '<option value="">Select size...</option>';

        // Add preset size options from enum
        for (const option of schema.enum) {
            const opt = document.createElement('option');
            opt.value = option;
            opt.textContent = option;
            select.appendChild(opt);
        }

        // Add Custom option only if ImageSize schema is available
        if (supportsCustomSize) {
            const customOpt = document.createElement('option');
            customOpt.value = 'custom';
            customOpt.textContent = 'Custom';
            select.appendChild(customOpt);
        }

        // Set default value if available
        if (schema.default) {
            select.value = schema.default;
        }

        container.appendChild(select);

        // Create custom size fields from ImageSize schema (initially hidden) only if supported
        if (supportsCustomSize && imageSizeSchema) {
            const customFields = document.createElement('div');
            customFields.className = 'custom-size-fields hidden';

            // Create fields based on ImageSize schema properties
            const widthProperty = imageSizeSchema.properties.width;
            const heightProperty = imageSizeSchema.properties.height;

            const widthField = document.createElement('div');
            widthField.className = 'custom-size-field';
            widthField.innerHTML = `
                <label for="${name}_width">${widthProperty.title || 'Width'}</label>
                <input type="number"
                       id="${name}_width"
                       name="${name}_width"
                       min="${widthProperty.exclusiveMinimum ? widthProperty.exclusiveMinimum + 1 : (widthProperty.minimum || 1)}"
                       max="${widthProperty.maximum || 14142}"
                       value="${widthProperty.default || 512}"
                       title="${widthProperty.description || ''}">
            `;

            const heightField = document.createElement('div');
            heightField.className = 'custom-size-field';
            heightField.innerHTML = `
                <label for="${name}_height">${heightProperty.title || 'Height'}</label>
                <input type="number"
                       id="${name}_height"
                       name="${name}_height"
                       min="${heightProperty.exclusiveMinimum ? heightProperty.exclusiveMinimum + 1 : (heightProperty.minimum || 1)}"
                       max="${heightProperty.maximum || 14142}"
                       value="${heightProperty.default || 512}"
                       title="${heightProperty.description || ''}">
            `;

            // Add scale field for proportional resizing
            const scaleField = document.createElement('div');
            scaleField.className = 'custom-size-field scale-field';
            scaleField.innerHTML = `
                <label for="${name}_scale">Scale</label>
                <div class="scale-controls">
                    <input type="range"
                           id="${name}_scale"
                           name="${name}_scale"
                           min="0.1"
                           max="2"
                           step="0.1"
                           value="1"
                           title="Scale factor for original image dimensions">
                    <span class="scale-value">100%</span>
                    <button type="button" class="btn secondary small reset-scale" title="Reset to original size">1:1</button>
                </div>
                <div class="original-size-info hidden">
                    <small>Original: <span class="original-dimensions">-</span> → Scaled: <span class="scaled-dimensions">-</span></small>
                </div>
            `;

            customFields.appendChild(widthField);
            customFields.appendChild(heightField);
            customFields.appendChild(scaleField);
            container.appendChild(customFields);

            // Add event listener to show/hide custom fields
            select.addEventListener('change', (e) => {
                if (this.debugMode) console.log('Image size changed to:', e.target.value);

                if (e.target.value === 'custom') {
                    customFields.classList.remove('hidden');
                } else {
                    customFields.classList.add('hidden');
                }
                // Only save if we are not restoring
                if (!this.isRestoring) {
                    this.saveEndpointSettings('image_size');
                } else {
                    if (this.debugMode) console.log('Skipping save during restore');
                }
            });

            // Add scale control functionality
            const scaleInput = scaleField.querySelector('input[type="range"]');
            const scaleValue = scaleField.querySelector('.scale-value');
            const resetButton = scaleField.querySelector('.reset-scale');
            const widthInput = widthField.querySelector('input');
            const heightInput = heightField.querySelector('input');
            const originalInfo = scaleField.querySelector('.original-size-info');
            const originalDimensions = scaleField.querySelector('.original-dimensions');
            const scaledDimensions = scaleField.querySelector('.scaled-dimensions');

            // Add change listeners to custom inputs to save settings
            widthInput.addEventListener('change', () => {
                if (!this.isRestoring) this.saveEndpointSettings('width');
            });
            heightInput.addEventListener('change', () => {
                if (!this.isRestoring) this.saveEndpointSettings('height');
            });
            scaleInput.addEventListener('change', () => {
                if (!this.isRestoring) this.saveEndpointSettings('image_size_scale');
            });

            // Store original dimensions
            let originalWidth = 0, originalHeight = 0;

            // Scale slider change handler function
            const handleScaleChange = (e) => {
                const scale = parseFloat(e.target.value);
                scaleValue.textContent = Math.round(scale * 100) + '%';

                if (originalWidth > 0 && originalHeight > 0) {
                    const newWidth = Math.round(originalWidth * scale);
                    const newHeight = Math.round(originalHeight * scale);

                    widthInput.value = newWidth;
                    heightInput.value = newHeight;
                    scaledDimensions.textContent = `${newWidth}×${newHeight}`;

                    // Trigger input events to save settings
                    widthInput.dispatchEvent(new Event('input', { bubbles: true }));
                    heightInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            };

            // Multiple event handlers for better mobile support
            scaleInput.addEventListener('input', handleScaleChange);
            scaleInput.addEventListener('change', handleScaleChange);

            // Additional mobile-specific touch support
            if (this.isMobileDevice()) {
                let isDragging = false;

                scaleInput.addEventListener('touchstart', () => {
                    isDragging = true;
                }, { passive: true });

                scaleInput.addEventListener('touchmove', (e) => {
                    if (isDragging) {
                        // Force update on touch move for mobile
                        setTimeout(() => {
                            handleScaleChange(e);
                        }, 10);
                    }
                }, { passive: true });

                scaleInput.addEventListener('touchend', (e) => {
                    if (isDragging) {
                        handleScaleChange(e);
                        isDragging = false;
                    }
                }, { passive: true });
            }

            // Reset scale button
            resetButton.addEventListener('click', () => {
                scaleInput.value = '1';
                scaleInput.dispatchEvent(new Event('input'));
            });

            // Function to set original dimensions and show scale controls
            container.setOriginalDimensions = (width, height) => {
                originalWidth = width;
                originalHeight = height;
                originalDimensions.textContent = `${width}×${height}`;
                scaledDimensions.textContent = `${width}×${height}`;
                originalInfo.classList.remove('hidden');
            };
        }

        field.appendChild(label);
        field.appendChild(container);

        return field;
    }

    getImageSizeSchemaFromAnyOf(schema) {
        // Find ImageSize schema reference from anyOf
        if (schema.anyOf) {
            for (const option of schema.anyOf) {
                if (option.$ref && option.$ref.includes('ImageSize')) {
                    // Resolve the ImageSize schema
                    return this.resolveSchema(option, this.currentEndpoint.schema);
                }
            }
        }
        return null;
    }

    exportSettings() {
        try {
            // Collect all settings including custom endpoints
            const customEndpoints = JSON.parse(localStorage.getItem('falai_custom_endpoints') || '{}');
            const likedImages = JSON.parse(localStorage.getItem('falai_liked_images') || '[]');
            const loraComments = JSON.parse(localStorage.getItem('falai_lora_comments') || '{}');
            const lastEndpoint = localStorage.getItem('falai_last_endpoint');
            const settings = {
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                apiKey: this.apiKey,
                endpointSettings: this.endpointSettings,
                savedImages: this.gallery.savedImages,
                likedImages: likedImages,
                debugMode: this.debugMode,
                advancedVisible: localStorage.getItem('falai_advanced_visible') === 'true',
                customEndpoints: customEndpoints,
                loraComments: loraComments,
                lastEndpoint: lastEndpoint
            };

            // Create and download file
            const blob = new Blob([JSON.stringify(settings, null, 2)], {
                type: 'application/json'
            });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
            a.href = url;
            a.download = `falai-settings-${timestamp}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            this.logDebug('Settings exported successfully', 'success');
            this.showToast('Success', 'Settings exported successfully!', 'success');

        } catch (error) {
            console.error('Export failed:', error);
            this.showToast('Error', 'Failed to export settings: ' + error.message, 'error');
            this.logDebug('Settings export failed: ' + error.message, 'error');
        }
    }

    async importSettings(file) {
        try {
            const text = await file.text();
            const settings = JSON.parse(text);

            // Validate settings structure
            if (!settings.version || !settings.endpointSettings) {
                throw new Error('Invalid settings file format');
            }

            // Show confirmation dialog
            const customEndpointsCount = settings.customEndpoints ? Object.keys(settings.customEndpoints).length : 0;
            const likedImagesCount = settings.likedImages ? settings.likedImages.length : 0;
            const loraCommentsCount = settings.loraComments ? Object.keys(settings.loraComments).length : 0;
            const message = `Import settings from ${settings.timestamp || 'unknown date'}?\n\nThis will replace:\n- All endpoint settings\n- API key\n- Saved images (${settings.savedImages?.length || 0} images)\n- Liked images (${likedImagesCount} likes)\n- Custom endpoints (${customEndpointsCount} endpoints)\n- LoRA comments (${loraCommentsCount} models)\n- Last selected endpoint\n- Other preferences`;

            if (!confirm(message)) {
                return;
            }

            // Import settings
            if (settings.apiKey) {
                this.apiKey = settings.apiKey;
                localStorage.setItem('falai_api_key', this.apiKey);
            }

            if (settings.endpointSettings) {
                // Filter out base64 data from imported settings
                const filteredSettings = {};
                for (const [endpointId, endpointData] of Object.entries(settings.endpointSettings)) {
                    filteredSettings[endpointId] = this.filterBase64Data(endpointData);
                }

                this.endpointSettings = filteredSettings;
                this.saveWithStorageCheck('falai_endpoint_settings', this.endpointSettings);
            }

            if (settings.savedImages) {
                this.gallery.savedImages = settings.savedImages;
                localStorage.setItem('falai_saved_images', JSON.stringify(this.gallery.savedImages));
            }

            if (settings.likedImages) {
                this.gallery.likedImages = settings.likedImages;
                localStorage.setItem('falai_liked_images', JSON.stringify(this.gallery.likedImages));
            }

            if (settings.loraComments) {
                localStorage.setItem('falai_lora_comments', JSON.stringify(settings.loraComments));
            }

            if (settings.lastEndpoint) {
                localStorage.setItem('falai_last_endpoint', settings.lastEndpoint);
            }
            if (settings.customEndpoints) {
                // Import custom endpoints
                localStorage.setItem('falai_custom_endpoints', JSON.stringify(settings.customEndpoints));
                // Reload custom endpoints into the current session
                for (const [id, endpoint] of Object.entries(settings.customEndpoints)) {
                    this.endpoints.set(id, endpoint);
                }
                // Re-render dropdown to show imported custom endpoints
                this.renderEndpointDropdown();
                this.logDebug(`Imported ${Object.keys(settings.customEndpoints).length} custom endpoints`, 'info');
            }

            if (settings.debugMode !== undefined) {
                this.debugMode = settings.debugMode;
                localStorage.setItem('falai_debug_mode', this.debugMode);
                document.getElementById('debug-checkbox').checked = this.debugMode;

                if (this.debugMode) {
                    this.logDebug('Debug mode imported and enabled', 'system');
                }
            }

            if (settings.advancedVisible !== undefined) {
                localStorage.setItem('falai_advanced_visible', settings.advancedVisible);
            }

            // Refresh UI
            if (this.currentEndpoint) {
                this.restoreEndpointSettings(this.currentEndpoint.metadata.endpointId);
            }

            // Refresh gallery if open
            const galleryTab = document.getElementById('gallery-panel-tab');
            if (galleryTab && galleryTab.classList.contains('active')) {
                this.gallery.showInlineGallery();
            }

            alert('Settings imported successfully!');
            this.showToast('Success', 'Settings imported successfully!', 'success');
            this.logDebug('Settings imported successfully', 'success', {
                endpointSettings: Object.keys(settings.endpointSettings || {}).length,
                savedImages: settings.savedImages?.length || 0
            });

        } catch (error) {
            console.error('Import failed:', error);
            this.showToast('Error', 'Failed to import settings: ' + error.message, 'error');
            alert('Failed to import settings: ' + error.message);
            this.logDebug('Settings import failed: ' + error.message, 'error');
        }
    }

    resetSettings() {
        if (!this.currentEndpoint) {
            this.showToast('Warning', 'No endpoint selected', 'warning');
            return;
        }

        if (confirm('Are you sure you want to reset settings for this endpoint? This will clear all custom values.')) {
            const endpointId = this.currentEndpoint.metadata.endpointId;

            // Clear settings for current endpoint
            if (this.endpointSettings[endpointId]) {
                delete this.endpointSettings[endpointId];
                // Save directly to storage to avoid re-capturing current form state
                this.saveWithStorageCheck('falai_endpoint_settings', this.endpointSettings);
            }

            // Regenerate form to apply defaults
            this.generateForm();

            this.showToast('Success', 'Settings reset to defaults', 'success');
            this.logDebug(`Settings reset for endpoint: ${endpointId}`, 'info');
        }
    }

    createArrayField(name, schema, required, label, field) {
        const arrayContainer = document.createElement('div');
        arrayContainer.className = 'array-field-container';

        const description = document.createElement('div');
        description.className = 'field-description';
        description.textContent = schema.description || '';

        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'array-items';
        itemsContainer.id = `${name}-items`;

        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'btn secondary small';
        addButton.textContent = '+ Add ' + (name === 'loras' ? 'LoRA' : 'Item');
        addButton.addEventListener('click', () => {
            this.addArrayItem(name, schema, itemsContainer);
        });

        field.appendChild(label);
        field.appendChild(description);
        field.appendChild(itemsContainer);
        field.appendChild(addButton);

        // Add initial empty item if default is not empty array
        if (schema.default && schema.default.length > 0) {
            schema.default.forEach(() => {
                this.addArrayItem(name, schema, itemsContainer);
            });
        }

        return field;
    }

    addArrayItem(arrayName, arraySchema, container) {
        const itemIndex = container.children.length;
        const itemContainer = document.createElement('div');
        itemContainer.className = 'array-item';

        // Check if this should be collapsible (only for LoRAs)
        const isCollapsible = arrayName === 'loras';
        let contentContainer = itemContainer;
        let headerTitle = null;
        let headerScale = null;

        if (isCollapsible) {
            itemContainer.classList.add('collapsible');

            // Create Header
            const header = document.createElement('div');
            header.className = 'array-item-header';

            const headerContent = document.createElement('div');
            headerContent.className = 'array-item-header-content';

            const toggleIcon = document.createElement('span');
            toggleIcon.className = 'array-item-toggle-icon';
            toggleIcon.innerHTML = '<i class="ph ph-caret-right"></i>';

            headerTitle = document.createElement('span');
            headerTitle.className = 'array-item-title';
            headerTitle.textContent = `LoRA ${itemIndex + 1}`;

            headerScale = document.createElement('span');
            headerScale.className = 'array-item-scale';
            headerScale.style.marginLeft = 'auto';
            headerScale.style.marginRight = '10px';
            headerScale.style.fontSize = '0.85rem';
            headerScale.style.color = 'var(--text-secondary)';

            headerContent.appendChild(toggleIcon);
            headerContent.appendChild(headerTitle);
            headerContent.appendChild(headerScale);
            header.appendChild(headerContent);

            // Create Content Container
            contentContainer = document.createElement('div');
            contentContainer.className = 'array-item-content';

            // Toggle Logic
            header.addEventListener('click', (e) => {
                if (e.target.closest('.btn.danger')) return;
                itemContainer.classList.toggle('expanded');
            });

            itemContainer.appendChild(header);
            itemContainer.appendChild(contentContainer);

            // Add Name field for LoRA items at the top
            this.addLoraNameField(arrayName, itemIndex, contentContainer);
        }

        // Resolve $ref if present
        let itemSchema = arraySchema.items;
        if (itemSchema.$ref) {
            const refPath = itemSchema.$ref.replace('#/components/schemas/', '');
            itemSchema = this.currentEndpoint.schema.components.schemas[refPath];
        }

        if (itemSchema.type === 'object' && itemSchema.properties) {
            // Handle object items (like LoraWeight)
            Object.entries(itemSchema.properties).forEach(([propName, propSchema]) => {
                const fieldName = `${arrayName}[${itemIndex}].${propName}`;
                const propField = this.createFormField(fieldName, propSchema,
                    itemSchema.required && itemSchema.required.includes(propName));
                propField.classList.add('array-item-field');
                contentContainer.appendChild(propField);

                // Add change listener to save settings
                const input = propField.querySelector('input, select, textarea');
                if (input) {
                    input.addEventListener('change', () => {
                        if (!this.isRestoring) this.saveEndpointSettings(fieldName);
                    });
                    input.addEventListener('input', () => {
                        if (!this.isRestoring) this.saveEndpointSettings(fieldName);
                    });
                }
            });
        } else {
            // Handle simple items
            const fieldName = `${arrayName}[${itemIndex}]`;
            const itemField = this.createFormField(fieldName, itemSchema, false);
            itemField.classList.add('array-item-field');
            contentContainer.appendChild(itemField);

            // Add change listener to save settings
            const input = itemField.querySelector('input, select, textarea');
            if (input) {
                input.addEventListener('change', () => {
                    if (!this.isRestoring) this.saveEndpointSettings(fieldName);
                });
                input.addEventListener('input', () => {
                    if (!this.isRestoring) this.saveEndpointSettings(fieldName);
                });
            }
        }

        // Add remove button
        const removeButton = document.createElement('button');
        removeButton.type = 'button';

        if (isCollapsible) {
            removeButton.className = 'btn danger';
            removeButton.textContent = 'Remove LoRA';
            removeButton.style.marginTop = '1rem';
            removeButton.style.width = '100%';
        } else {
            removeButton.className = 'btn danger small';
            removeButton.innerHTML = '<i class="ph ph-x"></i>';
        }

        removeButton.title = 'Remove';
        removeButton.addEventListener('click', () => {
            container.removeChild(itemContainer);
            this.updateArrayIndices(arrayName, container);
            if (!this.isRestoring) this.saveEndpointSettings(arrayName);
        });

        if (isCollapsible) {
            // Append to content container (expanded view) instead of header
            contentContainer.appendChild(removeButton);

            // Update title and scale
            const pathInput = contentContainer.querySelector('input[name*=".path"]');
            const scaleInput = contentContainer.querySelector('input[name*=".scale"], input[name*=".weight"]');
            const nameInput = contentContainer.querySelector(`input[name="${arrayName}[${itemIndex}].comment"]`);

            const updateHeader = () => {
                // Update Title
                if (nameInput && nameInput.value.trim()) {
                    headerTitle.textContent = nameInput.value.trim();
                } else if (pathInput && pathInput.value) {
                    let name = pathInput.value.split('/').pop();
                    if (name.includes('?')) name = name.split('?')[0];
                    // Remove extension if present
                    if (name.lastIndexOf('.') > 0) {
                        name = name.substring(0, name.lastIndexOf('.'));
                    }
                    headerTitle.textContent = name;
                } else {
                    headerTitle.textContent = `LoRA ${itemIndex + 1}`;
                }

                // Update Scale
                if (scaleInput) {
                    headerScale.textContent = `Scale: ${scaleInput.value}`;
                }
            };

            // Auto-fill name from path if name is empty
            if (pathInput && nameInput) {
                const autoFillName = async () => {
                    const pathValue = pathInput.value.trim();
                    if (!nameInput.value.trim() && pathValue) {
                        // Check for Civitai URL
                        const civitaiMatch = pathValue.match(/civitai\.com\/api\/download\/models\/(\d+)/);
                        if (civitaiMatch) {
                            const modelId = civitaiMatch[1];
                            try {
                                const response = await fetch(`https://civitai.com/api/v1/model-versions/${modelId}`);
                                if (response.ok) {
                                    const data = await response.json();
                                    // Try to find the file that matches the download URL or just take the first one
                                    let file = data.files.find(f => f.downloadUrl === pathValue) || data.files[0];
                                    if (file && file.name) {
                                        let name = file.name;
                                        // Remove extension
                                        if (name.lastIndexOf('.') > 0) {
                                            name = name.substring(0, name.lastIndexOf('.'));
                                        }
                                        nameInput.value = name;
                                        nameInput.dispatchEvent(new Event('input'));
                                        updateHeader();
                                        return; // Exit if successful
                                    }
                                }
                            } catch (e) {
                                console.warn('Failed to fetch Civitai metadata:', e);
                            }
                        }

                        // Fallback to simple path parsing
                        let name = pathValue.split('/').pop();
                        if (name.includes('?')) name = name.split('?')[0];
                        if (name.lastIndexOf('.') > 0) {
                            name = name.substring(0, name.lastIndexOf('.'));
                        }
                        nameInput.value = name;
                        // Trigger input event to save
                        nameInput.dispatchEvent(new Event('input'));
                    }
                    updateHeader();
                };
                pathInput.addEventListener('change', autoFillName);
                pathInput.addEventListener('input', updateHeader); // Update header immediately on typing
            }

            if (nameInput) {
                nameInput.addEventListener('input', updateHeader);
            }

            if (scaleInput) {
                scaleInput.addEventListener('input', updateHeader);
                scaleInput.addEventListener('change', updateHeader);
            }

            // Initial update
            setTimeout(updateHeader, 100);
        } else {
            itemContainer.appendChild(removeButton);
        }

        container.appendChild(itemContainer);
    }

    addLoraNameField(arrayName, itemIndex, itemContainer) {
        const fieldGroup = document.createElement('div');
        fieldGroup.className = 'field-group lora-comment-field';

        const label = document.createElement('label');
        label.textContent = 'Name';
        label.className = 'field-label';

        const input = document.createElement('input');
        input.type = 'text';
        input.name = `${arrayName}[${itemIndex}].comment`;
        input.id = `${arrayName}[${itemIndex}].comment`;
        input.className = 'form-input';
        input.placeholder = 'LoRA Name';

        // Load saved comment (now used as name)
        const savedComment = this.getLoraComment(arrayName, itemIndex);
        if (savedComment) {
            input.value = savedComment;
        }

        // Save comment on change
        input.addEventListener('input', () => {
            this.saveLoraComment(arrayName, itemIndex, input.value);
            if (!this.isRestoring) this.saveEndpointSettings(`${arrayName}[${itemIndex}].comment`);
        });

        fieldGroup.appendChild(label);
        fieldGroup.appendChild(input);
        itemContainer.appendChild(fieldGroup);
    }

    getLoraComment(arrayName, itemIndex) {
        const endpointId = this.currentEndpointId;
        const comments = JSON.parse(localStorage.getItem('falai_lora_comments') || sessionStorage.getItem('falai_lora_comments') || '{}');
        return comments[endpointId]?.[`${arrayName}[${itemIndex}]`] || '';
    }

    saveLoraComment(arrayName, itemIndex, comment) {
        // Debounce LoRA comment saving
        if (this._saveCommentTimeout) {
            clearTimeout(this._saveCommentTimeout);
        }

        this._saveCommentTimeout = setTimeout(() => {
            this.performSaveLoraComment(arrayName, itemIndex, comment);
        }, 1000);
    }

    performSaveLoraComment(arrayName, itemIndex, comment) {
        const endpointId = this.currentEndpointId;
        const comments = JSON.parse(localStorage.getItem('falai_lora_comments') || sessionStorage.getItem('falai_lora_comments') || '{}');

        if (!comments[endpointId]) {
            comments[endpointId] = {};
        }

        const key = `${arrayName}[${itemIndex}]`;
        if (comment.trim()) {
            comments[endpointId][key] = comment.trim();
        } else {
            delete comments[endpointId][key];
            // Clean up empty endpoint entries
            if (Object.keys(comments[endpointId]).length === 0) {
                delete comments[endpointId];
            }
        }

        this.saveWithStorageCheck('falai_lora_comments', comments);
        this.logDebug(`Saved LoRA comment for ${key}`, 'info');
    }

    updateArrayIndices(arrayName, container) {
        Array.from(container.children).forEach((item, index) => {
            const fields = item.querySelectorAll('input, select, textarea');
            fields.forEach(field => {
                if (field.name.startsWith(arrayName)) {
                    const oldName = field.name;
                    const oldIndex = oldName.match(/\[(\d+)\]/)?.[1];
                    const baseName = field.name.replace(/\[\d+\]/, `[${index}]`);
                    field.name = baseName;
                    field.id = baseName;

                    // Handle LoRA comment field updates
                    if (arrayName === 'loras' && oldName.includes('.comment') && oldIndex !== undefined) {
                        // Move comment from old index to new index
                        const oldComment = this.getLoraComment(arrayName, parseInt(oldIndex));
                        if (oldComment && parseInt(oldIndex) !== index) {
                            this.saveLoraComment(arrayName, index, oldComment);
                            // Clear old comment entry
                            this.saveLoraComment(arrayName, parseInt(oldIndex), '');
                        }
                    }
                }
            });
        });
    }

    async downloadImage(url, filename) {
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const downloadUrl = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = filename || 'image.jpg';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            URL.revokeObjectURL(downloadUrl);
        } catch (error) {
            console.error('Download failed:', error);
            alert('Download failed');
        }
    }


    saveWithStorageCheck(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify(data));
            // Also try to sync to sessionStorage as backup
            try { sessionStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
            if (this.debugMode) console.log(`✅ Saved to localStorage: ${key}`);
        } catch (error) {
            if (error.name === 'QuotaExceededError') {
                this.logDebug('Storage quota exceeded, attempting cleanup...', 'warning');

                // Try to free up space
                this.cleanupBase64Images();
                this.cleanupOldSettings();

                // Retry once
                try {
                    localStorage.setItem(key, JSON.stringify(data));
                    return;
                } catch (retryError) {
                    this.showToast('Storage Full', 'Browser storage is full. Please clear some saved images.', 'error');
                }
            } else {
                console.warn('❌ Storage error (likely blocked by Tracking Prevention):', error.message || error);
            }

            // Fallback to sessionStorage for any error (Quota or Blocked)
            try {
                sessionStorage.setItem(key, JSON.stringify(data));
                if (this.debugMode) console.log(`⚠️ Saved to sessionStorage as fallback for ${key} (localStorage blocked)`);
            } catch (sessionError) {
                console.error('❌ Both localStorage and sessionStorage failed:', sessionError);
            }
        }
    }

    cleanupBase64Images() {
        let totalCleaned = 0;
        let sizeFreed = 0;

        // Clean base64 images from endpoint settings
        for (const [endpointId, settings] of Object.entries(this.endpointSettings)) {
            for (const [key, value] of Object.entries(settings)) {
                if (typeof value === 'string' && this.isBase64DataURL(value)) {
                    const sizeBefore = new Blob([value]).size;
                    delete settings[key];
                    totalCleaned++;
                    sizeFreed += sizeBefore;
                    this.logDebug(`Removed base64 image from ${endpointId}.${key} (${this.formatBytes(sizeBefore)})`, 'info');
                }
            }
        }

        if (totalCleaned > 0) {
            this.saveWithStorageCheck('falai_endpoint_settings', this.endpointSettings);
            this.logDebug(`Cleaned up ${totalCleaned} base64 images, freed ${this.formatBytes(sizeFreed)}`, 'success');
        }

        return { count: totalCleaned, sizeFreed };
    }

    isBase64DataURL(str) {
        // Check if string is a data URL with base64 image
        return typeof str === 'string' &&
            str.startsWith('data:image/') &&
            str.includes('base64,') &&
            str.length > 1000; // Only consider large data URLs (small ones might be icons)
    }


    cleanupOldSettings() {
        // Clean up old endpoint settings for endpoints that no longer exist
        const currentEndpoints = new Set(Array.from(this.endpoints.keys()));
        const settingsKeys = Object.keys(this.endpointSettings);
        let cleaned = 0;

        for (const endpointId of settingsKeys) {
            if (!currentEndpoints.has(endpointId)) {
                delete this.endpointSettings[endpointId];
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.saveWithStorageCheck('falai_endpoint_settings', this.endpointSettings);
            this.logDebug(`Cleaned up settings for ${cleaned} removed endpoints`, 'info');
        }

        return cleaned;
    }











    async cancelGeneration() {
        if (!this.currentRequestId) return;

        try {
            const endpoint = this.currentEndpoint;
            const baseUrl = endpoint.schema.servers[0].url;
            const cancelPath = this.getCancelPath(endpoint.schema, this.currentRequestId);

            await fetch(baseUrl + cancelPath, {
                method: 'PUT',
                headers: {
                    'Authorization': `Key ${this.apiKey}`
                }
            });

            clearInterval(this.statusPolling);
            this.hideGenerationStatus();
        } catch (error) {
            console.error('Cancel failed:', error);
        }
    }

    getCancelPath(schema, requestId) {
        for (const [path, methods] of Object.entries(schema.paths)) {
            if (path.includes('/cancel') && methods.put) {
                return path.replace('{request_id}', requestId);
            }
        }
        throw new Error('No cancel endpoint found');
    }

    showGenerationStatus(message, type = 'generating') {
        const statusPanel = document.getElementById('generation-status');
        const statusMessage = document.getElementById('status-message');
        const statusContainer = statusPanel.querySelector('.status-container');
        const progressFill = document.getElementById('progress-fill');

        // Hide placeholder and results
        document.getElementById('no-images-placeholder').classList.add('hidden');
        document.getElementById('results').classList.add('hidden');
        document.getElementById('inline-gallery').classList.add('hidden');

        // Update message
        statusMessage.textContent = message;

        // Reset container classes
        statusContainer.className = 'status-container';

        // Add type-specific styling
        if (type === 'success') {
            statusContainer.classList.add('status-success');
            statusContainer.querySelector('.status-title').textContent = 'Generation Complete';
            progressFill.style.width = '100%';
        } else if (type === 'error') {
            statusContainer.classList.add('status-error');
            statusContainer.querySelector('.status-title').textContent = 'Generation Failed';
            progressFill.style.width = '0%';
        } else {
            statusContainer.querySelector('.status-title').textContent = 'Generating Image';
            // Keep current progress
        }

        // Show status panel
        statusPanel.classList.remove('hidden');

        this.logDebug(`Status shown: ${message}`, 'status', { type });
    }

    hideGenerationStatus() {
        document.getElementById('generation-status').classList.add('hidden');
        this.currentRequestId = null;

        // Reset progress
        document.getElementById('progress-fill').style.width = '0%';

        this.logDebug('Status hidden', 'status');
    }

    showError(message) {
        this.showGenerationStatus(message, 'error');

        // Also show toast notification
        this.showToast('Error', message, 'error');

        // Auto-hide error status after 5 seconds
        setTimeout(() => {
            this.hideGenerationStatus();
            document.getElementById('no-images-placeholder').classList.remove('hidden');
        }, 5000);

        this.logDebug('Error shown: ' + message, 'error');
    }

    showToast(title, message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        const icons = {
            success: '<i class="ph ph-check-circle"></i>',
            error: '<i class="ph ph-x-circle"></i>',
            warning: '<i class="ph ph-warning"></i>',
            info: '<i class="ph ph-info"></i>'
        };

        toast.innerHTML = `
            <div class="toast-icon">${icons[type] || icons.info}</div>
            <div class="toast-content">
                ${title ? `<div class="toast-title">${title}</div>` : ''}
                <div class="toast-message">${message}</div>
            </div>
        `;

        container.appendChild(toast);

        // Auto-remove after 3 seconds
        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.3s ease';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }, 3000);
    }

    hideResults() {
        document.getElementById('results').classList.add('hidden');
    }

    saveEndpointSettings(changedField = null) {
        // Auto-save disabled - settings are saved explicitly on:
        // - Mobile menu close (burger toggle)
        // - Generate button click
        // - Endpoint switch
        // - Page unload/visibility change
        if (this.debugMode && changedField) {
            console.log(`📝 Field changed: ${changedField} (will be saved on menu close or generate)`);
        }
    }

    performSaveEndpointSettings() {
        if (!this.currentEndpoint || this.isRestoring) return;

        // Safety check: Ensure form is actually populated
        const formFields = document.getElementById('form-fields');
        if (!formFields || formFields.children.length === 0) {
            if (this.debugMode) console.warn('saveEndpointSettings: Form fields empty, skipping save');
            return;
        }

        const formData = this.collectFormData();

        // Safety check: Ensure we collected something
        if (Object.keys(formData).length === 0) {
            if (this.debugMode) console.warn('saveEndpointSettings: Empty form data, skipping save');
            return;
        }

        // Filter out base64 image data to save localStorage space
        const filteredData = this.filterBase64Data(formData);

        // Debug log for all settings - show what will actually be saved (filtered data)
        if (this.debugMode) {
            console.log('💾 Saving settings for', this.currentEndpoint.metadata.endpointId);
            console.log('   Data:', JSON.stringify(filteredData, null, 2));
        }

        // Log size savings in debug mode
        if (this.debugMode) {
            const originalSize = JSON.stringify(formData).length;
            const filteredSize = JSON.stringify(filteredData).length;
            const saved = originalSize - filteredSize;
            if (saved > 0) {
                console.log(`💾 Settings size: ${this.formatBytes(filteredSize)} (saved ${this.formatBytes(saved)} by excluding base64)`);
            }
        }

        this.endpointSettings[this.currentEndpoint.metadata.endpointId] = filteredData;
        this.saveWithStorageCheck('falai_endpoint_settings', this.endpointSettings);
    }

    filterBase64Data(data) {
        const filtered = {};

        for (const [key, value] of Object.entries(data)) {
            // Skip fields with base64 image data
            if (this.isBase64DataURL(value)) {
                if (this.debugMode) {
                    console.log(`🚫 Excluding base64 field '${key}' from settings (${this.formatBytes(value.length)})`);
                }
                continue;
            }

            // Recursively filter objects and arrays
            if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) {
                    // Filter arrays
                    const filteredArray = value.map(item => {
                        if (typeof item === 'object' && item !== null) {
                            return this.filterBase64Data(item);
                        } else if (this.isBase64DataURL(item)) {
                            if (this.debugMode) {
                                console.log(`🚫 Excluding base64 array item from '${key}' (${this.formatBytes(item.length)})`);
                            }
                            return undefined; // Skip base64 items
                        }
                        return item;
                    }).filter(item => item !== undefined);

                    if (filteredArray.length > 0) {
                        filtered[key] = filteredArray;
                    }
                } else {
                    // Filter nested objects
                    const filteredObject = this.filterBase64Data(value);
                    if (Object.keys(filteredObject).length > 0) {
                        filtered[key] = filteredObject;
                    }
                }
            } else {
                filtered[key] = value;
            }
        }

        return filtered;
    }

    restoreEndpointSettings(endpointId) {
        const settings = this.endpointSettings[endpointId];
        if (!settings) return;

        if (this.debugMode) {
            console.log(`🔧 Restoring settings for ${endpointId}`);
            console.log('   Data:', JSON.stringify(settings, null, 2));
        }

        this.isRestoring = true;
        try {
            const form = document.getElementById('generation-form');

            for (const [key, value] of Object.entries(settings)) {
                // Handle array fields (like loras or image_urls)
                if (Array.isArray(value)) {
                    // Check if this is a multi-image field
                    const multiImageContainer = form.querySelector(`.multi-image-upload-container[data-field-name="${key}"]`);
                    if (multiImageContainer) {
                        this.restoreMultiImageField(key, value, form);
                        continue;
                    }
                    this.restoreArrayField(key, value, form);
                    continue;
                }

                // Handle image_size (both object and string/preset)
                if (key === 'image_size') {
                    this.restoreImageSizeField(value, form);
                    continue;
                }

                // Handle simple fields
                const input = form.querySelector(`[name="${key}"]`);
                if (!input) continue;

                if (input.type === 'checkbox') {
                    input.checked = Boolean(value);
                } else if (input.type === 'range') {
                    input.value = value;
                    // Update slider value display (old span element)
                    const valueDisplay = input.parentElement.querySelector('.slider-value');
                    if (valueDisplay) {
                        valueDisplay.textContent = value;
                    }
                    // Update slider value input (new input element)
                    const valueInput = input.parentElement.querySelector('.slider-value-input');
                    if (valueInput) {
                        valueInput.value = value;
                    }
                } else {
                    input.value = value;
                }

                // Trigger change event to update any dependent elements
                input.dispatchEvent(new Event('change'));
            }
        } finally {
            this.isRestoring = false;
        }
    }

    restoreMultiImageField(fieldName, images, form) {
        const container = form.querySelector(`.multi-image-upload-container[data-field-name="${fieldName}"]`);
        if (!container) return;

        const hiddenInput = container.querySelector(`input[name="${fieldName}"]`);
        const previewsContainer = container.querySelector(`#${fieldName}-previews`);

        if (hiddenInput && previewsContainer && Array.isArray(images) && images.length > 0) {
            hiddenInput.value = JSON.stringify(images);
            this.renderMultiImagePreviews(fieldName, images, previewsContainer, hiddenInput);
        }
    }

    restoreArrayField(fieldName, arrayValue, form) {
        const container = form.querySelector(`#${fieldName}-items`);
        if (!container) return;

        // Clear existing items
        container.innerHTML = '';

        // Add items for each saved value
        arrayValue.forEach((itemValue, index) => {
            // Get the schema for this array field
            const schema = this.getFieldSchema(fieldName);
            if (!schema) return;

            this.addArrayItem(fieldName, schema, container);

            // Set values for the newly added item
            if (typeof itemValue === 'object') {
                for (const [propName, propValue] of Object.entries(itemValue)) {
                    const input = container.querySelector(`[name="${fieldName}[${index}].${propName}"]`);
                    if (input) {
                        input.value = propValue;

                        // Update slider display if this is a range input
                        if (input.type === 'range') {
                            const valueDisplay = input.parentElement.querySelector('.slider-value');
                            const valueInput = input.parentElement.querySelector('.slider-value-input');
                            if (valueDisplay) valueDisplay.textContent = propValue;
                            if (valueInput) valueInput.value = propValue;
                        }
                    }
                }
            } else {
                const input = container.querySelector(`[name="${fieldName}[${index}]"]`);
                if (input) {
                    input.value = itemValue;

                    // Update slider display if this is a range input
                    if (input.type === 'range') {
                        const valueDisplay = input.parentElement.querySelector('.slider-value');
                        const valueInput = input.parentElement.querySelector('.slider-value-input');
                        if (valueDisplay) valueDisplay.textContent = itemValue;
                        if (valueInput) valueInput.value = itemValue;
                    }
                }
            }
        });
    }

    restoreImageSizeField(value, form) {
        // Try to find by name first, then by ID
        const select = form.querySelector('select[name="image_size"]') || document.getElementById('image_size');
        if (!select) {
            if (this.debugMode) console.warn('restoreImageSizeField: Select not found');
            return;
        }

        if (this.debugMode) console.log('Restoring image_size:', value);

        // Check if we have valid custom size data
        if (value && typeof value === 'object') {
            // Custom size
            select.value = 'custom';

            // Manually show custom fields
            const container = select.closest('.image-size-container');
            if (container) {
                const customFields = container.querySelector('.custom-size-fields');
                if (customFields) {
                    customFields.classList.remove('hidden');
                }
            }

            const widthInput = form.querySelector('input[name="image_size_width"]');
            const heightInput = form.querySelector('input[name="image_size_height"]');

            if (widthInput && value.width) {
                widthInput.value = value.width;
                widthInput.dispatchEvent(new Event('input'));
            }
            if (heightInput && value.height) {
                heightInput.value = value.height;
                heightInput.dispatchEvent(new Event('input'));
            }

            // Update scale info if available
            if (container && value.width && value.height) {
                const scaledDimensions = container.querySelector('.scaled-dimensions');
                if (scaledDimensions) {
                    scaledDimensions.textContent = `${value.width}×${value.height}`;
                }
            }
        } else {
            // Handle case where image_size is a string (preset)
            // We use the value directly, assuming it matches one of the options
            select.value = value;

            // Verify if the value was actually set (it might not exist in options)
            if (select.value !== value && this.debugMode) {
                console.warn(`restoreImageSizeField: Value '${value}' not found in options`, Array.from(select.options).map(o => o.value));
            }

            // Hide custom fields if they were visible
            const container = select.closest('.image-size-container');
            if (container) {
                const customFields = container.querySelector('.custom-size-fields');
                if (customFields) {
                    customFields.classList.add('hidden');
                }
            }
        }
    }

    getFieldSchema(fieldName) {
        if (!this.currentEndpoint) return null;

        const inputSchema = this.findInputSchema(this.currentEndpoint.schema);
        if (!inputSchema || !inputSchema.properties) return null;

        return inputSchema.properties[fieldName];
    }

    // Storage management functions
    getStorageSize() {
        let totalSize = 0;
        const storageData = {};

        for (let key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                const value = localStorage.getItem(key);
                const size = new Blob([value]).size;
                storageData[key] = {
                    size: size,
                    sizeFormatted: this.formatBytes(size),
                    items: key.startsWith('falai_') ?
                        (key === 'falai_saved_images' ? JSON.parse(value || '[]').length : 1) : 1
                };
                totalSize += size;
            }
        }

        return {
            total: totalSize,
            totalFormatted: this.formatBytes(totalSize),
            limit: this.getStorageLimit(),
            limitFormatted: this.formatBytes(this.getStorageLimit()),
            usage: (totalSize / this.getStorageLimit() * 100).toFixed(1),
            breakdown: storageData
        };
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    getStorageLimit() {
        // Return cached limit if already calculated
        if (this._cachedStorageLimit) {
            return this._cachedStorageLimit;
        }

        try {
            // Use common browser limits (testing is risky when storage is full)
            const userAgent = navigator.userAgent.toLowerCase();
            let limit = 10 * 1024 * 1024; // Default 10MB

            if (userAgent.includes('chrome') || userAgent.includes('edge')) {
                limit = 10 * 1024 * 1024; // Chrome/Edge: ~10MB
            } else if (userAgent.includes('firefox')) {
                limit = 10 * 1024 * 1024; // Firefox: ~10MB
            } else if (userAgent.includes('safari')) {
                limit = 5 * 1024 * 1024;  // Safari: ~5MB
            }

            // Cache the result
            this._cachedStorageLimit = limit;
            return limit;

        } catch (e) {
            this._cachedStorageLimit = 5 * 1024 * 1024; // 5MB fallback
            return this._cachedStorageLimit;
        }
    }

    logStorageInfo() {
        const info = this.getStorageSize();

        // Analyze base64 images in settings
        const base64Analysis = this.analyzeBase64Images();

        console.group('📊 LocalStorage Usage');
        console.log(`Total: ${info.totalFormatted} / ${info.limitFormatted} (${info.usage}%)`);

        if (base64Analysis.count > 0) {
            console.log(`⚠️  Base64 images found: ${base64Analysis.count} images (${this.formatBytes(base64Analysis.totalSize)})`);
        }

        console.log('Breakdown:');

        // Sort by size descending
        const sorted = Object.entries(info.breakdown)
            .sort(([, a], [, b]) => b.size - a.size);

        for (const [key, data] of sorted) {
            let extra = data.items > 1 ? ` (${data.items} items)` : '';
            if (key === 'falai_endpoint_settings' && base64Analysis.count > 0) {
                extra += ` - includes ${base64Analysis.count} base64 images`;
            }
            console.log(`  ${key}: ${data.sizeFormatted}${extra}`);
        }

        if (base64Analysis.count > 0) {
            console.log(`💡 Run falaiStorage.cleanBase64() to free up ${this.formatBytes(base64Analysis.totalSize)}`);
        }

        console.groupEnd();

        return info;
    }

    analyzeBase64Images() {
        let count = 0;
        let totalSize = 0;

        for (const settings of Object.values(this.endpointSettings)) {
            for (const value of Object.values(settings)) {
                if (typeof value === 'string' && this.isBase64DataURL(value)) {
                    count++;
                    totalSize += new Blob([value]).size;
                }
            }
        }

        return { count, totalSize };
    }

    showBase64Warning() {
        // Don't show multiple warnings in a short time
        const now = Date.now();
        if (this._lastBase64Warning && (now - this._lastBase64Warning) < 30000) {
            return; // Don't show again within 30 seconds
        }
        this._lastBase64Warning = now;

        // Show temporary notification
        const notification = document.createElement('div');
        notification.className = 'base64-warning';
        notification.innerHTML = `
            <div class="warning-content">
                <div class="warning-icon"><i class="ph ph-warning"></i></div>
                <div class="warning-text">
                    <strong>Temporary result format</strong>
                    <p>Server returned image in base64 format. This won't be saved to gallery automatically. Use the download button to save it now.</p>
                </div>
                <button class="warning-close" onclick="this.parentElement.remove()"><i class="ph ph-x"></i></button>
            </div>
        `;

        // Add styles if not already added
        if (!document.getElementById('base64-warning-styles')) {
            const styles = document.createElement('style');
            styles.id = 'base64-warning-styles';
            styles.textContent = `
                .base64-warning {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    z-index: 1000;
                    max-width: 400px;
                    background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
                    border: 1px solid #f59e0b;
                    border-radius: 12px;
                    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
                    animation: slideIn 0.3s ease-out;
                }

                .warning-content {
                    display: flex;
                    align-items: flex-start;
                    gap: 12px;
                    padding: 16px;
                }

                .warning-icon {
                    font-size: 24px;
                    flex-shrink: 0;
                }

                .warning-text {
                    flex: 1;
                }

                .warning-text strong {
                    color: #92400e;
                    font-size: 14px;
                    display: block;
                    margin-bottom: 4px;
                }

                .warning-text p {
                    color: #78350f;
                    font-size: 13px;
                    margin: 0;
                    line-height: 1.4;
                }

                .warning-close {
                    background: none;
                    border: none;
                    color: #92400e;
                    font-size: 16px;
                    cursor: pointer;
                    padding: 4px;
                    border-radius: 4px;
                    flex-shrink: 0;
                }

                .warning-close:hover {
                    background: rgba(146, 64, 14, 0.1);
                }

                @keyframes slideIn {
                    from {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
            `;
            document.head.appendChild(styles);
        }

        document.body.appendChild(notification);

        // Auto-remove after 10 seconds
        setTimeout(() => {
            if (notification.parentElement) {
                notification.style.animation = 'slideIn 0.3s ease-out reverse';
                setTimeout(() => notification.remove(), 300);
            }
        }, 10000);
    }

    restoreUIState() {
        // Restore advanced options state
        const advancedVisible = localStorage.getItem('falai_advanced_visible') === 'true';
        if (advancedVisible) {
            setTimeout(() => {
                const toggle = document.querySelector('.advanced-options-toggle');
                const content = document.querySelector('.advanced-options-content');
                if (toggle && content) {
                    content.classList.add('visible');
                    toggle.innerHTML = '<i class="ph ph-caret-up"></i> Advanced Options';
                }
            }, 100);
        }

        // Save advanced options state when toggled
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('advanced-options-toggle')) {
                setTimeout(() => {
                    const content = document.querySelector('.advanced-options-content');
                    if (content) {
                        localStorage.setItem('falai_advanced_visible',
                            content.classList.contains('visible'));
                    }
                }, 10);
            }
        });
    }

    setupPWA() {
        // Register service worker
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                // Use relative path to support subdirectories/GitHub Pages
                navigator.serviceWorker.register('./sw.js')
                    .then((registration) => {
                        console.log('ServiceWorker registration successful: ', registration.scope);
                    })
                    .catch((error) => {
                        console.log('ServiceWorker registration failed: ', error);
                    });
            });
        }

        // Handle install prompt
        let deferredPrompt;
        window.addEventListener('beforeinstallprompt', (e) => {
            // Prevent the mini-infobar from appearing
            e.preventDefault();
            deferredPrompt = e;

            // Show install button in header
            this.showInstallButton(deferredPrompt);
        });

        // Handle successful installation
        window.addEventListener('appinstalled', () => {
            console.log('FalAI was installed');
            this.hideInstallButton();
        });

        // Check if launched from PWA
        if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
            console.log('Running as PWA');
        }

        // Handle gallery shortcut
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('gallery') === 'true') {
            setTimeout(() => this.showGallery(), 1000);
        }
    }

    showInstallButton(deferredPrompt) {
        // 1. Desktop Button (in header)
        const headerControls = document.querySelector('.header-controls');
        if (!headerControls.querySelector('#install-btn')) {
            const installBtn = document.createElement('button');
            installBtn.id = 'install-btn';
            installBtn.className = 'btn secondary';
            installBtn.innerHTML = '<i class="ph ph-download-simple"></i> Install App'; // Added icon
            installBtn.title = 'Install App';

            installBtn.addEventListener('click', async () => {
                if (deferredPrompt) {
                    deferredPrompt.prompt();
                    const { outcome } = await deferredPrompt.userChoice;
                    console.log(`User response to install prompt: ${outcome}`);
                    deferredPrompt = null;
                    this.hideInstallButton();
                }
            });
            headerControls.insertBefore(installBtn, headerControls.firstChild);
        }

        // 2. Mobile Button (in mobile menu)
        const mobileMenuControls = document.querySelector('.mobile-menu-controls .mobile-menu-section .mobile-menu-content');
        // If we can't find the specific content container, fallback to the first section
        const targetContainer = mobileMenuControls || document.querySelector('.mobile-menu-controls .mobile-menu-section');

        if (targetContainer && !document.getElementById('mobile-install-btn')) {
            const mobileInstallBtn = document.createElement('button');
            mobileInstallBtn.id = 'mobile-install-btn';
            mobileInstallBtn.className = 'mobile-menu-btn';
            mobileInstallBtn.innerHTML = '<i class="ph ph-download-simple"></i> Install App';

            mobileInstallBtn.addEventListener('click', async () => {
                if (deferredPrompt) {
                    deferredPrompt.prompt();
                    const { outcome } = await deferredPrompt.userChoice;
                    console.log(`User response to install prompt: ${outcome}`);
                    deferredPrompt = null;
                    this.hideInstallButton();
                }
            });

            // Insert at the top of the mobile menu list
            targetContainer.insertBefore(mobileInstallBtn, targetContainer.firstChild);
        }
    }

    hideInstallButton() {
        const installBtn = document.getElementById('install-btn');
        if (installBtn) installBtn.remove();

        const mobileInstallBtn = document.getElementById('mobile-install-btn');
        if (mobileInstallBtn) mobileInstallBtn.remove();
    }

    // Custom endpoint functions
    handleSchemaFileSelection(file) {
        const schemaFileInfo = document.getElementById('schema-file-info');
        const schemaFileName = document.getElementById('schema-file-name');

        schemaFileName.textContent = file.name;
        schemaFileInfo.classList.remove('hidden');
    }

    clearSchemaFileSelection() {
        const schemaFileInfo = document.getElementById('schema-file-info');
        const schemaFileInput = document.getElementById('openapi-file');

        schemaFileInfo.classList.add('hidden');
        schemaFileInput.value = '';
    }

    closeCustomEndpointModal() {
        document.getElementById('custom-endpoint-modal').classList.add('hidden');
        this.clearSchemaFileSelection();
    }

    async addCustomEndpoint() {
        try {
            // Load from file
            const fileInput = document.getElementById('openapi-file');
            const file = fileInput.files[0];
            if (!file) {
                alert('Please select a JSON file');
                return;
            }

            this.logDebug(`Loading custom endpoint from file: ${file.name}`, 'info');
            const schema = await this.loadEndpointFromFile(file);
            const endpointName = file.name.replace(/\.json$/, '');

            // Validate schema
            if (!this.validateOpenAPISchema(schema)) {
                return; // Error already shown in validate function
            }

            // Add to endpoints
            const customId = `custom-${Date.now()}`;
            this.endpoints.set(customId, {
                schema: schema,
                metadata: this.extractMetadata(schema, endpointName)
            });

            // Save custom endpoints to localStorage
            this.saveCustomEndpoints();

            // Update dropdown
            this.renderEndpointDropdown();

            // Close modal
            this.closeCustomEndpointModal();

            // Show success message
            this.logDebug(`Successfully added custom endpoint: ${endpointName}`, 'success');
            alert(`Successfully added custom endpoint: ${endpointName}`);

        } catch (error) {
            console.error('Failed to add custom endpoint:', error);
            this.logDebug(`Failed to add custom endpoint: ${error.message}`, 'error');
            alert(`Failed to add custom endpoint: ${error.message}`);
        }
    }


    async loadEndpointFromFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const schema = JSON.parse(e.target.result);
                    resolve(schema);
                } catch (error) {
                    reject(new Error('Invalid JSON file'));
                }
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    validateOpenAPISchema(schema) {
        if (!schema || typeof schema !== 'object') {
            alert('Invalid schema: must be a JSON object');
            return false;
        }

        if (!schema.openapi) {
            alert('Invalid schema: missing "openapi" field');
            return false;
        }

        if (!schema.info) {
            alert('Invalid schema: missing "info" field');
            return false;
        }

        if (!schema.paths) {
            alert('Invalid schema: missing "paths" field');
            return false;
        }

        // Check for POST endpoints
        const hasPostEndpoint = Object.values(schema.paths).some(path => path.post);
        if (!hasPostEndpoint) {
            alert('Warning: No POST endpoints found in schema');
        }

        return true;
    }

    extractMetadata(schema, fallbackName) {
        const info = schema.info;
        let metadata = {
            endpointId: info.title || fallbackName,
            category: 'custom',
            thumbnailUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="%234f46e5"/><text x="50" y="50" text-anchor="middle" dy="0.35em" fill="white" font-size="50" font-family="sans-serif" font-weight="bold">C</text></svg>',
            playgroundUrl: '#',
            documentationUrl: info.externalDocs?.url || '#'
        };

        // Try to extract fal.ai metadata if present
        if (info['x-fal-metadata']) {
            metadata = { ...metadata, ...info['x-fal-metadata'] };
        }

        return metadata;
    }

    openMaskEditor(fieldName, urlInput) {
        // Get reference image from image_url field or other image fields
        let referenceImageUrl = null;

        // Try different common names for reference image
        const imageFieldNames = ['image_url', 'image', 'input_image', 'source_image'];

        for (const fieldName of imageFieldNames) {
            const imageField = document.querySelector(`[name="${fieldName}"]`);
            if (imageField && imageField.value) {
                referenceImageUrl = imageField.value;
                break;
            }
        }

        if (!referenceImageUrl) {
            alert('Please upload or enter a reference image first (in the image field)');
            return;
        }

        // Create mask editor modal
        this.createMaskEditorModal(fieldName, urlInput, referenceImageUrl);
    }

    createMaskEditorModal(fieldName, urlInput, referenceImageUrl) {
        // Remove existing modal if any
        const existingModal = document.getElementById('mask-editor-modal');
        if (existingModal) {
            existingModal.remove();
        }

        // Create modal
        const modal = document.createElement('div');
        modal.id = 'mask-editor-modal';
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content mask-editor-content">
                <div class="modal-header">
                    <div class="mask-editor-hotkeys" style="display: ${this.isMobileDevice() ? 'none' : 'block'}">
                        <small><i class="ph ph-lightbulb"></i> Hotkeys: Shift+Wheel (zoom), Alt+Wheel (brush size), Ctrl+Z (undo), Ctrl+Y (redo), R (reset zoom), F (fit screen), Esc (close)</small>
                    </div>
                    <button type="button" id="close-mask-editor" class="btn secondary small"><i class="ph ph-x"></i></button>
                </div>
                <div class="mask-editor-body">
                    <div class="mask-editor-controls">
                        <div class="control-group">
                            <label>Brush Size:</label>
                            <div class="brush-size-row">
                                <button type="button" id="brush-smaller" class="btn secondary small">-</button>
                                <input type="range" id="brush-size" min="1" max="100" value="20">
                                <span id="brush-size-value">20px</span>
                                <button type="button" id="brush-larger" class="btn secondary small">+</button>
                            </div>
                        </div>
                        <div class="control-group">
                            <button type="button" id="zoom-out" class="btn secondary small" title="Zoom out"><i class="ph ph-magnifying-glass-minus"></i></button>
                            <button type="button" id="zoom-in" class="btn secondary small" title="Zoom in"><i class="ph ph-magnifying-glass-plus"></i></button>
                            <button type="button" id="zoom-fit" class="btn secondary small" title="Fit to screen (F)"><i class="ph ph-arrows-out"></i> Fit</button>
                            <button type="button" id="zoom-reset" class="btn secondary small" title="Reset zoom (R)"><i class="ph ph-arrow-counter-clockwise"></i> Reset</button>
                        </div>
                        <div class="control-group">
                            <button type="button" id="undo-mask" class="btn secondary small" disabled title="Undo (Ctrl+Z)"><i class="ph ph-arrow-u-up-left"></i> Undo</button>
                            <button type="button" id="redo-mask" class="btn secondary small" disabled title="Redo (Ctrl+Y)"><i class="ph ph-arrow-u-up-right"></i> Redo</button>
                            <button type="button" id="clear-mask" class="btn secondary small" title="Clear all"><i class="ph ph-trash"></i> Clear</button>
                        </div>
                    </div>
                    <div class="canvas-container" id="canvas-container">
                        <canvas id="mask-canvas"></canvas>
                    </div>
                    <div class="mask-editor-actions">
                        <button type="button" id="cancel-mask" class="btn secondary">Cancel</button>
                        <button type="button" id="apply-mask" class="btn primary">Apply Mask</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.classList.remove('hidden');

        // Block body scrolling on mobile
        if (this.isMobileDevice()) {
            document.body.style.overflow = 'hidden';
        }

        // Initialize mask editor
        this.initializeMaskEditor(modal, fieldName, urlInput, referenceImageUrl);
    }

    initializeMaskEditor(modal, fieldName, urlInput, referenceImageUrl) {
        console.log('🎨 Initializing Fabric.js mask editor for field:', fieldName);

        const canvasElement = modal.querySelector('#mask-canvas');
        const canvasContainer = modal.querySelector('#canvas-container');
        const brushSizeSlider = modal.querySelector('#brush-size');
        const brushSizeValue = modal.querySelector('#brush-size-value');
        const undoBtn = modal.querySelector('#undo-mask');
        const redoBtn = modal.querySelector('#redo-mask');
        const zoomFitBtn = modal.querySelector('#zoom-fit');
        const zoomResetBtn = modal.querySelector('#zoom-reset');
        const zoomInBtn = modal.querySelector('#zoom-in');
        const zoomOutBtn = modal.querySelector('#zoom-out');
        const brushSmallerBtn = modal.querySelector('#brush-smaller');
        const brushLargerBtn = modal.querySelector('#brush-larger');

        // Debug: Check if all required elements exist
        if (!canvasElement) {
            console.error('❌ Canvas element not found');
            return;
        }

        let fabricCanvas;
        let undoStack = [];
        let redoStack = [];

        // State for zoom and pan
        let zoomLevel = 1;
        let panX = 0;
        let panY = 0;

        // Load reference image first
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            // Calculate available space for canvas
            const container = canvasContainer;
            const containerRect = container.getBoundingClientRect();

            // Get available dimensions considering mobile interface
            let maxWidth, maxHeight;
            if (this.isMobileDevice()) {
                // On mobile, use more of the available space
                maxWidth = Math.min(window.innerWidth - 40, 600); // 20px padding each side
                maxHeight = Math.min(window.innerHeight * 0.6, 400); // 60% of screen height max
            } else {
                maxWidth = 700;
                maxHeight = 500;
            }

            let canvasWidth = img.width;
            let canvasHeight = img.height;

            // Calculate scale factor to fit within max dimensions while preserving aspect ratio
            const scaleX = maxWidth / canvasWidth;
            const scaleY = maxHeight / canvasHeight;
            const scale = Math.min(scaleX, scaleY, 1); // Don't upscale, only downscale

            // Apply the scale factor
            canvasWidth = Math.round(canvasWidth * scale);
            canvasHeight = Math.round(canvasHeight * scale);

            console.log('📏 Canvas sizing:', {
                original: { width: img.width, height: img.height },
                maxSize: { width: maxWidth, height: maxHeight },
                final: { width: canvasWidth, height: canvasHeight },
                scale: scale
            });

            // Initialize Fabric.js canvas with exact calculated dimensions
            fabricCanvas = new fabric.Canvas(canvasElement, {
                width: canvasWidth,
                height: canvasHeight,
                isDrawingMode: true,
                selection: false,
                preserveObjectStacking: true,
                enableRetinaScaling: true
            });

            // Store original dimensions for zoom calculations
            fabricCanvas.originalWidth = canvasWidth;
            fabricCanvas.originalHeight = canvasHeight;

            // Make canvas container properly sized and scrollable for zoom
            canvasContainer.style.position = 'relative';
            canvasContainer.style.overflow = 'auto';
            canvasContainer.style.width = '100%';
            canvasContainer.style.height = '100%';

            // Set initial canvas size but allow viewport adjustments
            canvasElement.style.width = canvasWidth + 'px';
            canvasElement.style.height = canvasHeight + 'px';

            // Fix touch coordinates for mobile devices
            if (this.isMobileDevice()) {
                this.setupMobileTouchFix(fabricCanvas);
            }

            // Add background image with exact fit (no additional scaling)
            const backgroundImg = new fabric.Image(img, {
                left: 0,
                top: 0,
                scaleX: scale,
                scaleY: scale,
                selectable: false,
                evented: false,
                excludeFromExport: false
            });

            fabricCanvas.setBackgroundImage(backgroundImg, () => {
                fabricCanvas.renderAll();

                // Force canvas to update its internal coordinates
                fabricCanvas.calcOffset();

                // Additional calibration for mobile devices
                if (this.isMobileDevice()) {
                    // Force recalculation after a short delay to ensure proper sizing
                    setTimeout(() => {
                        fabricCanvas.calcOffset();
                        console.log('📱 Mobile canvas coordinates recalibrated');
                    }, 100);
                }

                console.log('✅ Canvas size:', canvasWidth, 'x', canvasHeight);
                console.log('✅ Image scale:', scale);
                console.log('✅ Original image size:', img.width, 'x', img.height);
            });

            // Configure drawing brush
            fabricCanvas.freeDrawingBrush = new fabric.PencilBrush(fabricCanvas);
            fabricCanvas.freeDrawingBrush.width = 20;
            fabricCanvas.freeDrawingBrush.color = 'rgba(255, 0, 0, 0.4)'; // Semi-transparent red

            // Add event listener for coordinate debugging
            fabricCanvas.on('mouse:down', function (e) {
                const pointer = fabricCanvas.getPointer(e.e);
                console.log('🖱️ Click at canvas coordinates:', pointer.x, pointer.y);
            });

            // Improved touch coordinate handling for mobile
            if (this.isMobileDevice()) {
                console.log('📱 Setting up improved touch coordinates for mobile');

                // Override default pointer calculation for better accuracy
                const originalGetPointer = fabricCanvas.getPointer;
                fabricCanvas.getPointer = function (e, ignoreZoom) {
                    // For touch events, use custom calculation that respects zoom
                    if ((e.touches || e.changedTouches) && !ignoreZoom) {
                        const touch = e.touches?.[0] || e.changedTouches?.[0];
                        if (touch) {
                            const rect = this.upperCanvasEl.getBoundingClientRect();

                            // Get raw touch coordinates relative to canvas
                            const rawX = touch.clientX - rect.left;
                            const rawY = touch.clientY - rect.top;

                            // Apply zoom and viewport transform
                            const vpt = this.viewportTransform;
                            const zoom = this.getZoom();

                            // Convert screen coordinates to canvas coordinates
                            const pointer = {
                                x: (rawX - vpt[4]) / zoom,
                                y: (rawY - vpt[5]) / zoom
                            };

                            console.log('📱 Touch corrected (zoom-aware):', pointer.x, pointer.y, 'zoom:', zoom);
                            return pointer;
                        }
                    }

                    // Use original for non-touch events
                    return originalGetPointer.call(this, e, ignoreZoom);
                };
            }

            // Store initial state for undo after everything is set up
            setTimeout(() => {
                saveState();
                updateUndoRedoButtons();
            }, 100);

            // Setup event listeners
            setupControls();
            setupUndoRedo();
            setupZoomPan.call(this);
            setupHotkeys();

            console.log('✅ Fabric.js canvas initialized successfully');
        };

        img.onerror = () => {
            console.error('❌ Failed to load reference image:', referenceImageUrl);
            alert('Failed to load reference image. Please try again.');
        };

        img.src = referenceImageUrl;

        function setupControls() {
            // Brush size control
            brushSizeSlider.addEventListener('input', () => {
                const size = parseInt(brushSizeSlider.value);
                fabricCanvas.freeDrawingBrush.width = size;
                brushSizeValue.textContent = size + 'px';
            });

            // Clear mask - remove only drawn paths, keep background image
            modal.querySelector('#clear-mask').addEventListener('click', () => {
                // Get all objects except background
                const objects = fabricCanvas.getObjects();
                // Remove only drawn objects (paths), keeping background
                objects.forEach(obj => {
                    if (obj.type === 'path') {
                        fabricCanvas.remove(obj);
                    }
                });
                fabricCanvas.renderAll();
                saveState();
            });

            // Zoom controls
            zoomFitBtn.addEventListener('click', fitToContainer);
            zoomResetBtn.addEventListener('click', resetZoom);
            zoomInBtn.addEventListener('click', () => {
                const center = { x: fabricCanvas.width / 2, y: fabricCanvas.height / 2 };
                zoom(center, 1.2);
            });
            zoomOutBtn.addEventListener('click', () => {
                const center = { x: fabricCanvas.width / 2, y: fabricCanvas.height / 2 };
                zoom(center, 0.8);
            });

            // Brush size controls
            brushSmallerBtn.addEventListener('click', () => {
                adjustBrushSize(-5);
            });
            brushLargerBtn.addEventListener('click', () => {
                adjustBrushSize(5);
            });
        }

        function setupUndoRedo() {
            // Save state after each drawing action
            fabricCanvas.on('path:created', () => {
                saveState();
            });

            undoBtn.addEventListener('click', undo);
            redoBtn.addEventListener('click', redo);
        }

        function saveState() {
            const state = JSON.stringify(fabricCanvas.toJSON());
            undoStack.push(state);
            redoStack = []; // Clear redo stack when new action is performed

            // Limit undo stack size
            if (undoStack.length > 20) {
                undoStack.shift();
            }

            updateUndoRedoButtons();
        }

        function undo() {
            if (undoStack.length > 1) {
                redoStack.push(undoStack.pop());
                const state = undoStack[undoStack.length - 1];
                fabricCanvas.loadFromJSON(state, () => {
                    fabricCanvas.renderAll();
                    updateUndoRedoButtons();
                });
            }
        }

        function redo() {
            if (redoStack.length > 0) {
                const state = redoStack.pop();
                undoStack.push(state);
                fabricCanvas.loadFromJSON(state, () => {
                    fabricCanvas.renderAll();
                    updateUndoRedoButtons();
                });
            }
        }

        function updateUndoRedoButtons() {
            undoBtn.disabled = undoStack.length <= 1;
            redoBtn.disabled = redoStack.length === 0;
        }

        function setupZoomPan() {
            function showZoomFeedback(zoomLevel) {
                // Remove existing feedback if present
                const existingFeedback = document.querySelector('.zoom-feedback');
                if (existingFeedback) {
                    existingFeedback.remove();
                }

                // Create zoom feedback element
                const feedback = document.createElement('div');
                feedback.className = 'zoom-feedback';
                feedback.textContent = `${Math.round(zoomLevel * 100)}%`;
                feedback.style.cssText = `
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    background: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 0.5rem 1rem;
                    border-radius: 20px;
                    font-size: 1.2rem;
                    font-weight: bold;
                    z-index: 3000;
                    pointer-events: none;
                    opacity: 0.9;
                    transition: opacity 0.3s ease;
                `;

                document.body.appendChild(feedback);

                // Remove feedback after a short delay
                setTimeout(() => {
                    feedback.style.opacity = '0';
                    setTimeout(() => {
                        if (feedback.parentNode) {
                            feedback.remove();
                        }
                    }, 300);
                }, 800);
            }

            // Mouse wheel zoom with Shift key (instead of Ctrl to avoid browser zoom conflict)
            canvasContainer.addEventListener('wheel', (e) => {
                if (e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    const delta = e.deltaY > 0 ? 0.9 : 1.1;
                    const pointer = fabricCanvas.getPointer(e);
                    zoom(pointer, delta);
                } else if (e.altKey) {
                    // Alt + wheel for brush size
                    e.preventDefault();
                    e.stopPropagation();
                    adjustBrushSize(e.deltaY > 0 ? -5 : 5);
                }
            }, { passive: false });

            // Pan with middle mouse or Ctrl+drag (when not drawing)
            let isPanning = false;
            let lastPanPoint = null;

            canvasContainer.addEventListener('mousedown', (e) => {
                if (e.button === 1 || (e.button === 0 && e.ctrlKey && !fabricCanvas.isDrawingMode)) {
                    isPanning = true;
                    lastPanPoint = { x: e.clientX, y: e.clientY };
                    canvasContainer.style.cursor = 'grabbing';
                    fabricCanvas.isDrawingMode = false; // Disable drawing during pan
                    e.preventDefault();
                }
            });

            canvasContainer.addEventListener('mousemove', (e) => {
                if (isPanning && lastPanPoint) {
                    const deltaX = e.clientX - lastPanPoint.x;
                    const deltaY = e.clientY - lastPanPoint.y;
                    pan(deltaX, deltaY);
                    lastPanPoint = { x: e.clientX, y: e.clientY };
                }
            });

            canvasContainer.addEventListener('mouseup', () => {
                if (isPanning) {
                    isPanning = false;
                    lastPanPoint = null;
                    canvasContainer.style.cursor = 'default';
                    fabricCanvas.isDrawingMode = true; // Re-enable drawing
                }
            });

            // Touch gestures for mobile
            if (this.isMobileDevice()) {
                let initialDistance = 0;
                let initialScale = 1;
                let touches = [];

                canvasContainer.addEventListener('touchstart', (e) => {
                    touches = Array.from(e.touches);

                    if (touches.length === 2) {
                        // Two-finger touch for zoom
                        e.preventDefault();
                        fabricCanvas.isDrawingMode = false; // Disable drawing during zoom

                        const touch1 = touches[0];
                        const touch2 = touches[1];
                        initialDistance = Math.hypot(
                            touch2.clientX - touch1.clientX,
                            touch2.clientY - touch1.clientY
                        );
                        initialScale = fabricCanvas.getZoom();
                    }
                }, { passive: false });

                canvasContainer.addEventListener('touchmove', (e) => {
                    touches = Array.from(e.touches);

                    if (touches.length === 2) {
                        e.preventDefault();

                        const touch1 = touches[0];
                        const touch2 = touches[1];
                        const currentDistance = Math.hypot(
                            touch2.clientX - touch1.clientX,
                            touch2.clientY - touch1.clientY
                        );

                        if (initialDistance > 0) {
                            const scale = (currentDistance / initialDistance) * initialScale;
                            const centerX = (touch1.clientX + touch2.clientX) / 2;
                            const centerY = (touch1.clientY + touch2.clientY) / 2;

                            // Convert screen coordinates to canvas coordinates
                            const rect = canvasContainer.getBoundingClientRect();
                            const pointer = {
                                x: (centerX - rect.left) * (fabricCanvas.width / rect.width),
                                y: (centerY - rect.top) * (fabricCanvas.height / rect.height)
                            };

                            fabricCanvas.zoomToPoint(new fabric.Point(pointer.x, pointer.y), Math.max(0.1, Math.min(5, scale)));

                            // Force canvas offset recalculation after zoom
                            setTimeout(() => {
                                fabricCanvas.calcOffset();
                            }, 50);

                            // Show zoom level feedback on mobile
                            if (this.isMobileDevice()) {
                                showZoomFeedback(scale);
                            }
                        }
                    }
                }, { passive: false });

                canvasContainer.addEventListener('touchend', (e) => {
                    if (touches.length === 2) {
                        fabricCanvas.isDrawingMode = true; // Re-enable drawing
                    }
                    touches = [];
                    initialDistance = 0;
                }, { passive: false });
            }
        }

        function setupHotkeys() {
            const handleKeydown = (e) => {
                // Only handle keys if mask editor modal is active
                if (!modal.parentNode) return;

                switch (e.key.toLowerCase()) {
                    case 'r':
                        if (!e.ctrlKey && !e.altKey) {
                            e.preventDefault();
                            resetZoom();
                        }
                        break;
                    case 'f':
                        if (!e.ctrlKey && !e.altKey) {
                            e.preventDefault();
                            fitToContainer();
                        }
                        break;
                    case 'z':
                        if (e.ctrlKey && !e.shiftKey) {
                            e.preventDefault();
                            undo();
                        }
                        break;
                    case 'y':
                        if (e.ctrlKey) {
                            e.preventDefault();
                            redo();
                        }
                        break;
                    case 'escape':
                        e.preventDefault();
                        if (fabricCanvas) fabricCanvas.dispose();
                        // Restore body scrolling
                        document.body.style.overflow = '';
                        modal.remove();
                        break;
                }
            };

            document.addEventListener('keydown', handleKeydown);

            // Clean up event listener on modal close
            const cleanup = () => document.removeEventListener('keydown', handleKeydown);
            modal.addEventListener('remove', cleanup);
        }

        function adjustBrushSize(delta) {
            const currentSize = parseInt(brushSizeSlider.value);
            const newSize = Math.max(1, Math.min(100, currentSize + delta));
            brushSizeSlider.value = newSize;
            fabricCanvas.freeDrawingBrush.width = newSize;
            brushSizeValue.textContent = newSize + 'px';
        }

        function zoom(point, delta) {
            const oldZoom = fabricCanvas.getZoom();
            const newZoom = Math.max(0.1, Math.min(5, oldZoom * delta));

            fabricCanvas.zoomToPoint(new fabric.Point(point.x, point.y), newZoom);
            zoomLevel = newZoom;

            // Update canvas display size to match new zoom level
            const imageWidth = fabricCanvas.originalWidth;
            const imageHeight = fabricCanvas.originalHeight;
            const scaledWidth = imageWidth * newZoom;
            const scaledHeight = imageHeight * newZoom;
            canvasElement.style.width = scaledWidth + 'px';
            canvasElement.style.height = scaledHeight + 'px';

            // Force offset recalculation after zoom (especially important on mobile)
            setTimeout(() => {
                fabricCanvas.calcOffset();
            }, 50);
        }

        function pan(deltaX, deltaY) {
            const vpt = fabricCanvas.viewportTransform;
            vpt[4] += deltaX;
            vpt[5] += deltaY;
            fabricCanvas.setViewportTransform(vpt);
            fabricCanvas.renderAll();
        }

        function resetZoom() {
            // Reset to show actual 1:1 pixel ratio of original image
            // Canvas is already scaled down, so we need to zoom up to compensate
            const bgImage = fabricCanvas.backgroundImage;
            const originalImageWidth = bgImage.width; // Real image size
            const canvasScale = originalImageWidth / fabricCanvas.width; // How much canvas was scaled down

            // Set zoom to compensate for canvas scaling
            const realZoom = canvasScale;
            fabricCanvas.setZoom(realZoom);

            // Reset viewport position
            fabricCanvas.absolutePan({ x: 0, y: 0 });

            // Update canvas display size to show real image size
            canvasElement.style.width = originalImageWidth + 'px';
            canvasElement.style.height = bgImage.height + 'px';

            fabricCanvas.renderAll();
            zoomLevel = realZoom;

            // Force offset recalculation
            setTimeout(() => {
                fabricCanvas.calcOffset();
            }, 50);

            console.log(`🔄 Reset to 1:1 - zoom: ${realZoom.toFixed(3)} (canvas was scaled down by ${canvasScale.toFixed(3)})`);
        }

        function fitToContainer() {
            // Fit image to container while maintaining aspect ratio
            const containerWidth = canvasContainer.clientWidth - 40; // padding
            const containerHeight = canvasContainer.clientHeight - 40;

            // Get real image dimensions
            const bgImage = fabricCanvas.backgroundImage;
            const originalImageWidth = bgImage.width;
            const originalImageHeight = bgImage.height;

            // Calculate scale to fit real image within container
            let fitScale = Math.min(containerWidth / originalImageWidth, containerHeight / originalImageHeight);

            // Don't scale up beyond original size
            fitScale = Math.min(fitScale, 1);

            // Canvas was already scaled down, so we need to account for that
            const canvasDownscale = originalImageWidth / fabricCanvas.width;
            const fabricZoom = fitScale * canvasDownscale;

            // Set zoom and center viewport
            fabricCanvas.setZoom(fabricZoom);
            fabricCanvas.absolutePan({ x: 0, y: 0 });

            // Update canvas display size to match fitted dimensions
            const displayWidth = originalImageWidth * fitScale;
            const displayHeight = originalImageHeight * fitScale;
            canvasElement.style.width = displayWidth + 'px';
            canvasElement.style.height = displayHeight + 'px';

            fabricCanvas.renderAll();
            zoomLevel = fabricZoom;

            // Force offset recalculation
            setTimeout(() => {
                fabricCanvas.calcOffset();
            }, 50);

            console.log(`📐 Fit to container: display ${displayWidth}×${displayHeight}, fabric zoom: ${fabricZoom.toFixed(3)}`);
        }

        // Close modal handlers
        modal.querySelector('#close-mask-editor').addEventListener('click', () => {
            if (fabricCanvas) fabricCanvas.dispose();
            // Restore body scrolling
            document.body.style.overflow = '';
            modal.remove();
        });

        modal.querySelector('#cancel-mask').addEventListener('click', () => {
            if (fabricCanvas) fabricCanvas.dispose();
            // Restore body scrolling
            document.body.style.overflow = '';
            modal.remove();
        });

        // Apply mask
        modal.querySelector('#apply-mask').addEventListener('click', () => {
            if (fabricCanvas) {
                this.generateMaskFromFabricCanvas(fabricCanvas, urlInput);
                fabricCanvas.dispose();
            }
            // Restore body scrolling
            document.body.style.overflow = '';
            modal.remove();
        });
    }

    generateMaskFromFabricCanvas(fabricCanvas, urlInput) {
        console.log('🎨 Generating mask from Fabric.js canvas');

        // Get the original image dimensions that were used for the background
        const bgImage = fabricCanvas.backgroundImage;
        const originalWidth = bgImage.width;
        const originalHeight = bgImage.height;

        console.log('📐 Original image size:', originalWidth, 'x', originalHeight);
        console.log('📐 Canvas size:', fabricCanvas.width, 'x', fabricCanvas.height);
        console.log('📐 Number of drawn objects:', fabricCanvas.getObjects().length);

        // Create mask in original image size for maximum quality
        let maskWidth = originalWidth;
        let maskHeight = originalHeight;

        console.log('📏 Creating mask in original image size for quality');

        // Create a temporary canvas with target mask size
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');

        tempCanvas.width = maskWidth;
        tempCanvas.height = maskHeight;

        // Start with black background
        tempCtx.fillStyle = 'black';
        tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

        // Calculate scale factor from fabric canvas to original image size
        const scaleToOriginal = maskWidth / fabricCanvas.width;

        // Get all drawn objects (paths)
        const objects = fabricCanvas.getObjects();

        if (objects.length === 0) {
            console.warn('[WARNING] No drawn objects found, creating empty black mask');
        } else {
            console.log('✅ Found', objects.length, 'drawn objects');

            // Set white brush for mask
            tempCtx.fillStyle = 'white';
            tempCtx.strokeStyle = 'white';
            tempCtx.globalCompositeOperation = 'source-over';

            // Draw each path object scaled to original size
            objects.forEach((obj, index) => {
                if (obj.type === 'path') {
                    console.log(`🎨 Processing path ${index + 1}/${objects.length}`);

                    // Get the path data and scale it
                    const pathData = obj.path;
                    if (pathData && pathData.length > 0) {
                        tempCtx.beginPath();
                        tempCtx.lineWidth = (obj.strokeWidth || 20) * scaleToOriginal;
                        tempCtx.lineCap = 'round';
                        tempCtx.lineJoin = 'round';

                        // Process the path commands
                        for (let i = 0; i < pathData.length; i++) {
                            const cmd = pathData[i];
                            const command = cmd[0];

                            switch (command) {
                                case 'M': // Move to
                                    tempCtx.moveTo(cmd[1] * scaleToOriginal, cmd[2] * scaleToOriginal);
                                    break;
                                case 'L': // Line to
                                    tempCtx.lineTo(cmd[1] * scaleToOriginal, cmd[2] * scaleToOriginal);
                                    break;
                                case 'Q': // Quadratic curve
                                    tempCtx.quadraticCurveTo(
                                        cmd[1] * scaleToOriginal, cmd[2] * scaleToOriginal,
                                        cmd[3] * scaleToOriginal, cmd[4] * scaleToOriginal
                                    );
                                    break;
                                case 'C': // Cubic curve
                                    tempCtx.bezierCurveTo(
                                        cmd[1] * scaleToOriginal, cmd[2] * scaleToOriginal,
                                        cmd[3] * scaleToOriginal, cmd[4] * scaleToOriginal,
                                        cmd[5] * scaleToOriginal, cmd[6] * scaleToOriginal
                                    );
                                    break;
                            }
                        }
                        tempCtx.stroke();
                    }
                }
            });
        }

        // Convert to base64 and set in input
        const maskDataUrl = tempCanvas.toDataURL('image/png');
        urlInput.value = maskDataUrl;

        // Trigger input event to update preview
        urlInput.dispatchEvent(new Event('input'));

        // Save settings
        this.saveEndpointSettings(urlInput.name || 'mask_url');

        console.log('✅ Fabric.js mask generated and applied to', urlInput.name);
        console.log('📐 Final mask size:', tempCanvas.width, 'x', tempCanvas.height);
    }
    saveCustomEndpoints() {
        const customEndpoints = {};
        for (const [id, endpoint] of this.endpoints.entries()) {
            if (id.startsWith('custom-')) {
                customEndpoints[id] = endpoint;
            }
        }
        localStorage.setItem('falai_custom_endpoints', JSON.stringify(customEndpoints));
    }

    loadCustomEndpoints() {
        try {
            const saved = localStorage.getItem('falai_custom_endpoints');
            if (saved) {
                const customEndpoints = JSON.parse(saved);
                for (const [id, endpoint] of Object.entries(customEndpoints)) {
                    this.endpoints.set(id, endpoint);
                }
                this.logDebug(`Loaded ${Object.keys(customEndpoints).length} custom endpoints`, 'info');
            }
        } catch (error) {
            console.warn('Failed to load custom endpoints:', error);
        }
    }


    // Persistent generation state management
    saveGenerationState(state) {
        localStorage.setItem('falai_generation_state', JSON.stringify(state));
        this.logDebug('Saved generation state', 'info', state);
    }

    clearGenerationState() {
        localStorage.removeItem('falai_generation_state');
        this.logDebug('Cleared generation state', 'info');
    }

    checkIncompleteGeneration() {
        const savedState = localStorage.getItem('falai_generation_state');
        if (!savedState) return;

        try {
            const state = JSON.parse(savedState);

            this.logDebug('Found incomplete generation, resuming...', 'info', state);

            // Restore state
            this.currentRequestId = state.requestId;
            this.statusUrl = state.statusUrl;
            this.resultUrl = state.resultUrl;

            // Show status and start polling
            this.showGenerationStatus('Resuming generation...');
            const generateBtn = document.querySelector('.generate-btn');
            if (generateBtn) {
                generateBtn.classList.add('loading');
                const generateText = generateBtn.querySelector('.generate-text');
                const generateLoading = generateBtn.querySelector('.generate-loading');
                if (generateText) generateText.classList.add('hidden');
                if (generateLoading) generateLoading.classList.remove('hidden');
            }

            // Resume polling
            this.startStatusPolling();

        } catch (error) {
            console.error('Error resuming generation:', error);
            this.clearGenerationState();
        }
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    const falai = new FalAI();
    window.app = falai; // Export for debugging
    console.log('FalAI initialized');
});
