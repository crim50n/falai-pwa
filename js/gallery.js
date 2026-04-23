/**
 * Gallery module: handles saved/generated images, selection, and PhotoSwipe integration.
 */

class FalAIGallery {
    constructor(app) {
        this.app = app;
        this.savedImages = JSON.parse(localStorage.getItem('falai_saved_images') || '[]');
        this.likedImages = JSON.parse(localStorage.getItem('falai_liked_images') || '[]');
        this.currentImageIndex = 0;

        // Filter state
        this.showOnlyLiked = false;

        // Selection state
        this.selectionMode = false;
        this.selectedImages = new Set();

        // Context menu state
        this.currentContextMenuImage = null;
        this.longPressTimer = null;
        this.longPressThreshold = 500; // 500ms for long press

        this.initializeEventListeners();
        this.initializeContextMenu();
        this.updateMobileStickyHeights();

        // Initialize galleries if they exist
        setTimeout(() => {
            if (document.getElementById('inline-gallery-content')) {
                this.showInlineGallery();
            }
            if (document.getElementById('mobile-gallery-content')) {
                this.updateMobileGallery();
            }
        }, 100);

        window.addEventListener('resize', () => this.updateMobileStickyHeights());
        window.falGallery = this; // expose for photoswipe-init
    }

    initializeEventListeners() {
        // Right panel tab controls
        const resultsTabEl = document.getElementById('results-panel-tab');
        if (resultsTabEl) {
            resultsTabEl.addEventListener('click', () => {
                this.switchRightPanelView('results');
            });
        }
        const galleryTabEl = document.getElementById('gallery-panel-tab');
        if (galleryTabEl) {
            galleryTabEl.addEventListener('click', () => {
                this.switchRightPanelView('gallery');
            });
        }

        // Selection mode controls (both inline & mobile)
        const selectionButtons = document.querySelectorAll('.selection-mode-btn');
        selectionButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                this.toggleSelectionMode();
                selectionButtons.forEach(b => {
                    b.textContent = this.selectionMode ? 'Cancel' : 'Select';
                    b.classList.toggle('active', this.selectionMode);
                });
            });
        });

        // Inline bulk action controls (multiple scopes)
        document.querySelectorAll('.select-all-btn').forEach(btn => {
            btn.addEventListener('click', () => this.selectAllImages());
        });
        document.querySelectorAll('.clear-selection-btn').forEach(btn => {
            btn.addEventListener('click', () => this.clearSelection());
        });
        document.querySelectorAll('.bulk-delete-btn').forEach(btn => {
            btn.addEventListener('click', () => this.bulkDeleteImages());
        });
        document.querySelectorAll('.select-not-liked-btn').forEach(btn => {
            btn.addEventListener('click', () => this.selectNotLikedImages());
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            // Only handle shortcuts when gallery is visible and not in input
            const galleryVisible = !document.getElementById('inline-gallery')?.classList.contains('hidden');
            if (!galleryVisible || e.target.matches('input, textarea')) return;

            switch (e.key) {
                case 'Escape':
                    if (this.selectionMode) {
                        this.toggleSelectionMode();
                        document.querySelectorAll('.selection-mode-btn').forEach(b => {
                            b.textContent = 'Select';
                            b.classList.remove('active');
                        });
                    }
                    break;
                case 'a':
                case 'A':
                    if ((e.ctrlKey || e.metaKey) && this.selectionMode) {
                        e.preventDefault();
                        this.selectAllImages();
                    }
                    break;
                case 'Delete':
                case 'Backspace':
                    if (this.selectionMode && this.selectedImages.size > 0) {
                        e.preventDefault();
                        this.bulkDeleteImages();
                    }
                    break;
            }
        });
    }

    initializeContextMenu() {
        const contextMenu = document.getElementById('gallery-context-menu');
        if (!contextMenu) return;

        // Hide context menu when clicking outside
        document.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        });

        // Handle context menu item clicks
        contextMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            const menuItem = e.target.closest('.context-menu-item');
            if (!menuItem || !this.currentContextMenuImage) return;

            const action = menuItem.dataset.action;
            const imageData = this.currentContextMenuImage;

            this.handleContextMenuAction(action, imageData);
            this.hideContextMenu();
        });

        // Prevent default context menu on the gallery context menu itself
        contextMenu.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        // Hide context menu on escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideContextMenu();
            }
        });
    }

    showContextMenu(x, y, imageData) {
        const contextMenu = document.getElementById('gallery-context-menu');
        if (!contextMenu) return;

        this.currentContextMenuImage = imageData;
        
        // Update like button text based on current state
        const likeText = contextMenu.querySelector('.toggle-like-text');
        const isLiked = this.likedImages.includes(String(imageData.timestamp));
        if (likeText) {
            likeText.textContent = isLiked ? 'Unlike' : 'Like';
        }

        // Show/hide restore metadata option based on available data
        const restoreOption = contextMenu.querySelector('[data-action="restore-metadata"]');
        if (restoreOption) {
            const hasApiResponse = imageData.api_response;
            const hasMissingData = !imageData.prompt || !imageData.seed;
            restoreOption.style.display = (hasApiResponse && hasMissingData) ? 'flex' : 'none';
        }

        // Show/hide use prompt and use seed options based on available data
        const usePromptOption = contextMenu.querySelector('[data-action="use-prompt"]');
        const useSeedOption = contextMenu.querySelector('[data-action="use-seed"]');
        
        if (usePromptOption) {
            const restoredData = this.restoreMetadataFromApiResponse(imageData);
            const hasPrompt = restoredData.prompt || imageData.prompt;
            usePromptOption.style.display = hasPrompt ? 'flex' : 'none';
        }
        
        if (useSeedOption) {
            const restoredData = this.restoreMetadataFromApiResponse(imageData);
            const hasSeed = restoredData.seed || imageData.seed;
            useSeedOption.style.display = hasSeed ? 'flex' : 'none';
        }

        // Position the menu
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        
        // Show the menu
        contextMenu.classList.remove('hidden');
        
        // Adjust position if menu goes off screen
        setTimeout(() => {
            const rect = contextMenu.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            
            if (rect.right > viewportWidth) {
                contextMenu.style.left = (viewportWidth - rect.width - 10) + 'px';
            }
            
            if (rect.bottom > viewportHeight) {
                contextMenu.style.top = (viewportHeight - rect.height - 10) + 'px';
            }
        }, 0);
    }

    hideContextMenu() {
        const contextMenu = document.getElementById('gallery-context-menu');
        if (contextMenu) {
            contextMenu.classList.add('hidden');
            this.currentContextMenuImage = null;
        }
    }

    handleContextMenuAction(action, imageData) {
        switch (action) {
            case 'download':
                this.downloadImage(imageData);
                break;
            case 'copy-url':
                this.copyImageUrl(imageData);
                break;
            case 'toggle-like':
                this.toggleLike(imageData.timestamp);
                break;
            case 'set-as-input':
                this.setAsInput(imageData);
                break;
            case 'use-prompt':
                this.usePrompt(imageData);
                break;
            case 'use-seed':
                this.useSeed(imageData);
                break;
            case 'view-metadata':
                this.viewImageMetadata(imageData);
                break;
            case 'restore-metadata':
                this.permanentlyRestoreMetadata(imageData.timestamp);
                break;
            case 'delete':
                this.deleteImage(imageData);
                break;
        }
    }

    downloadImage(imageData) {
        const link = document.createElement('a');
        link.href = imageData.url;
        link.download = `falai-${imageData.endpoint}-${imageData.timestamp}.${this.getImageExtension(imageData.url)}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        if (this.app && this.app.showNotification) {
            this.app.showNotification('Image downloaded', 'success');
        }
    }

    copyImageUrl(imageData) {
        navigator.clipboard.writeText(imageData.url).then(() => {
            if (this.app && this.app.showNotification) {
                this.app.showNotification('Image URL copied to clipboard', 'success');
            }
        }).catch(() => {
            if (this.app && this.app.showNotification) {
                this.app.showNotification('Failed to copy URL', 'error');
            }
        });
    }

    viewImageMetadata(imageData) {
        // Try to restore missing metadata from stored API response
        const restoredData = this.restoreMetadataFromApiResponse(imageData);
        
        const metadata = {
            'Generated': new Date(restoredData.timestamp).toLocaleString(),
            'Endpoint': restoredData.endpoint,
            'Prompt': restoredData.prompt || 'N/A',
            'Seed': restoredData.seed || 'N/A',
            'Request ID': restoredData.request_id || 'N/A',
            ...restoredData.parameters
        };

        // Add API response data if available
        if (restoredData.api_response) {
            metadata['Inference Time'] = restoredData.api_response.timings?.inference ? 
                `${restoredData.api_response.timings.inference.toFixed(2)}s` : 'N/A';
            metadata['NSFW Detected'] = restoredData.api_response.has_nsfw_concepts ? 
                restoredData.api_response.has_nsfw_concepts.join(', ') : 'N/A';
        }

        let metadataText = 'Image Details:\n\n';
        Object.entries(metadata).forEach(([key, value]) => {
            metadataText += `${key}: ${value}\n`;
        });

        alert(metadataText);
    }

    restoreMetadataFromApiResponse(imageData) {
        // Return copy with restored data from API response if available
        const restored = { ...imageData };
        
        if (imageData.api_response) {
            // Restore missing prompt from API response
            if (!restored.prompt && imageData.api_response.prompt) {
                restored.prompt = imageData.api_response.prompt;
            }
            
            // Restore missing seed from API response
            if (!restored.seed && imageData.api_response.seed) {
                restored.seed = imageData.api_response.seed;
            }
            
            // Restore missing parameters from API response
            if (imageData.api_response.form_params) {
                restored.parameters = {
                    ...imageData.api_response.form_params,
                    ...restored.parameters
                };
            }
        }
        
        return restored;
    }

    // Method to permanently restore metadata for an image
    permanentlyRestoreMetadata(imageId) {
        const imageIndex = this.savedImages.findIndex(img => img.timestamp === imageId);
        if (imageIndex === -1) return false;

        const originalImage = this.savedImages[imageIndex];
        const restoredImage = this.restoreMetadataFromApiResponse(originalImage);
        
        // Update the saved image with restored data
        this.savedImages[imageIndex] = restoredImage;
        this.saveImages();
        this.showInlineGallery();
        this.updateMobileGallery();
        
        if (this.app && this.app.showNotification) {
            this.app.showNotification('Metadata restored from API response', 'success');
        }
        
        return true;
    }

    deleteImage(imageData) {
        if (confirm('Are you sure you want to delete this image? This action cannot be undone.')) {
            this.savedImages = this.savedImages.filter(img => img.timestamp !== imageData.timestamp);
            this.saveImages();
            this.showInlineGallery();
            this.updateMobileGallery();
            
            if (this.app && this.app.showNotification) {
                this.app.showNotification('Image deleted', 'success');
            }
        }
    }

    setAsInput(imageData) {
        // Find the first available image upload field and set this image as input
        const uploadContainers = document.querySelectorAll('.image-upload-container');
        
        if (uploadContainers.length === 0) {
            if (this.app && this.app.showNotification) {
                this.app.showNotification('No image input fields available in current form', 'warning');
            }
            return;
        }

        // Use the first available image field
        const container = uploadContainers[0];
        const urlInput = container.querySelector('input[type="text"]');
        const uploadArea = container.querySelector('.upload-area');
        const preview = container.querySelector('.image-preview');

        if (urlInput && uploadArea && preview) {
            urlInput.value = imageData.url;
            
            // Show the image preview
            const img = preview.querySelector('img');
            if (img) {
                img.src = imageData.url;
                uploadArea.classList.add('hidden');
                preview.classList.remove('hidden');
            }

            // Trigger input event to save settings
            urlInput.dispatchEvent(new Event('input'));

            if (this.app && this.app.showNotification) {
                this.app.showNotification('Image set as input', 'success');
            }
        }
    }

    usePrompt(imageData) {
        // Get prompt from image data, try to restore if missing
        const restoredData = this.restoreMetadataFromApiResponse(imageData);
        const prompt = restoredData.prompt || imageData.prompt;
        
        if (!prompt) {
            if (this.app && this.app.showNotification) {
                this.app.showNotification('No prompt available for this image', 'warning');
            }
            return;
        }

        const promptInput = document.getElementById('prompt');
        if (promptInput) {
            promptInput.value = prompt;
            // Trigger input event for any listeners
            promptInput.dispatchEvent(new Event('input', { bubbles: true }));
            
            if (this.app && this.app.showNotification) {
                this.app.showNotification('Prompt applied to form', 'success');
            }
        } else {
            if (this.app && this.app.showNotification) {
                this.app.showNotification('Prompt field not found', 'error');
            }
        }
    }

    useSeed(imageData) {
        // Get seed from image data, try to restore if missing
        const restoredData = this.restoreMetadataFromApiResponse(imageData);
        const seed = restoredData.seed || imageData.seed;
        
        if (!seed) {
            if (this.app && this.app.showNotification) {
                this.app.showNotification('No seed available for this image', 'warning');
            }
            return;
        }

        const seedInput = document.getElementById('seed');
        if (seedInput) {
            seedInput.value = seed;
            // Trigger input event for any listeners
            seedInput.dispatchEvent(new Event('input', { bubbles: true }));
            
            if (this.app && this.app.showNotification) {
                this.app.showNotification('Seed applied to form', 'success');
            }
        } else {
            if (this.app && this.app.showNotification) {
                this.app.showNotification('Seed field not found', 'error');
            }
        }
    }

    getImageExtension(url) {
        if (this.isVideoItem({ url, type: this.getMediaTypeFromUrl(url) })) {
            return 'mp4';
        }

        if (url.startsWith('data:image/')) {
            const mimeType = url.split(';')[0].split(':')[1];
            return mimeType.split('/')[1];
        }
        return 'png';
    }

    getMediaTypeFromUrl(url = '') {
        if (url.startsWith('data:video/')) return 'video';
        if (url.startsWith('data:image/')) return 'image';

        try {
            const normalizedUrl = new URL(url, window.location.href);
            const path = normalizedUrl.pathname.toLowerCase();
            if (path.endsWith('.mp4') || path.endsWith('.webm') || path.endsWith('.mov')) {
                return 'video';
            }
        } catch (e) {
            const normalized = url.split('?')[0].toLowerCase();
            if (normalized.endsWith('.mp4') || normalized.endsWith('.webm') || normalized.endsWith('.mov')) {
                return 'video';
            }
        }

        return 'image';
    }

    isVideoItem(imageData = {}) {
        return imageData.type === 'video' || this.getMediaTypeFromUrl(imageData.url) === 'video';
    }

    createGalleryMediaElement(imageData, altText) {
        if (this.isVideoItem(imageData)) {
            const video = document.createElement('video');
            video.src = imageData.url;
            video.className = 'gallery-media gallery-video';
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            video.loop = true;

            video.addEventListener('mouseenter', () => {
                const playPromise = video.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => { });
                }
            });

            video.addEventListener('mouseleave', () => {
                video.pause();
                video.currentTime = 0;
            });

            return video;
        }

        const img = document.createElement('img');
        img.src = imageData.url;
        img.alt = altText;
        img.loading = 'lazy';
        img.className = 'gallery-media';
        return img;
    }

    addContextMenuEvents(element, imageData) {
        // Right-click context menu for desktop
        element.addEventListener('contextmenu', (e) => {
            if (this.selectionMode) return; // Don't show context menu in selection mode
            e.preventDefault();
            e.stopPropagation();
            this.showContextMenu(e.clientX, e.clientY, imageData);
        });

        // Touch events for mobile long press
        let touchStartTime = 0;
        let touchTimer = null;
        let touchStartX = 0;
        let touchStartY = 0;
        const longPressThreshold = 500; // 500ms
        const moveThreshold = 10; // 10px movement threshold

        element.addEventListener('touchstart', (e) => {
            if (this.selectionMode) return; // Don't handle touch in selection mode
            
            touchStartTime = Date.now();
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
            
            // Clear any existing timer
            if (touchTimer) {
                clearTimeout(touchTimer);
            }
            
            // Set up long press timer
            touchTimer = setTimeout(() => {
                e.preventDefault();
                e.stopPropagation();
                this.showContextMenu(touchStartX, touchStartY, imageData);
                
                // Add haptic feedback if available
                if (navigator.vibrate) {
                    navigator.vibrate(50);
                }
            }, longPressThreshold);
        }, { passive: false });

        element.addEventListener('touchmove', (e) => {
            if (!touchTimer) return;
            
            const touch = e.touches[0];
            const moveX = Math.abs(touch.clientX - touchStartX);
            const moveY = Math.abs(touch.clientY - touchStartY);
            
            // Cancel long press if user moved too much
            if (moveX > moveThreshold || moveY > moveThreshold) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
        });

        element.addEventListener('touchend', () => {
            // Cancel long press timer on touch end
            if (touchTimer) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
        });

        element.addEventListener('touchcancel', () => {
            // Cancel long press timer on touch cancel
            if (touchTimer) {
                clearTimeout(touchTimer);
                touchTimer = null;
            }
        });
    }

    // (placeholder for future lightbox-related helpers if needed)

    // Switch between Results and Gallery views
    switchRightPanelView(view) {
        const resultsTab = document.getElementById('results-panel-tab');
        const galleryTab = document.getElementById('gallery-panel-tab');
        const placeholder = document.getElementById('no-images-placeholder');
        const results = document.getElementById('results');
        const inlineGallery = document.getElementById('inline-gallery');

        if (view === 'gallery') {
            // Switch to gallery view
            if (resultsTab) resultsTab.classList.remove('active');
            if (galleryTab) galleryTab.classList.add('active');
            placeholder.classList.add('hidden');
            results.classList.add('hidden');
            inlineGallery.classList.remove('hidden');

            // Load gallery content
            this.showInlineGallery();
        } else {
            // Switch to results view
            if (galleryTab) galleryTab.classList.remove('active');
            if (resultsTab) resultsTab.classList.add('active');
            inlineGallery.classList.add('hidden');

            // Show appropriate results content
            if (results.classList.contains('hidden') && placeholder.classList.contains('hidden')) {
                placeholder.classList.remove('hidden');
            } else {
                results.classList.remove('hidden');
            }
        }
    }

    // Switch to gallery view programmatically
    switchToGalleryView() {
        this.switchRightPanelView('gallery');
    }

    // Display inline gallery with images
    showInlineGallery() {
        const container = document.getElementById('inline-gallery-content');

        if (!container) return;

        container.innerHTML = '';

        if (this.savedImages.length === 0) {
            container.innerHTML = '<div class="text-center" style="grid-column: 1/-1; padding: 2rem; color: #6b7280;">No saved images yet</div>';
        } else {
            this.savedImages.forEach((image, index) => {
                const item = this.createInlineGalleryItem(image, index);
                container.appendChild(item);
            });
        }

        // Update like indicators after DOM update
        requestAnimationFrame(() => {
            this.updateGalleryLikes();
        });

        // PhotoSwipe reads DOM on open; no explicit reinit needed
    }

    // Create gallery item for inline display (PhotoSwipe)
    createInlineGalleryItem(imageData, index) {
        const div = document.createElement('div');
        div.className = 'gallery-item';
        div.setAttribute('data-image-id', imageData.timestamp); // Unique identifier

        // Check if liked and add class
        const isLiked = this.likedImages.includes(String(imageData.timestamp));
        if (isLiked) {
            div.classList.add('liked');
        }

        const date = new Date(imageData.timestamp).toLocaleDateString();

        // Selection checkbox
        const selectionOverlay = document.createElement('div');
        selectionOverlay.className = 'gallery-item-selection';
        selectionOverlay.innerHTML = `
            <div class="selection-checkbox">
                <input type="checkbox" id="select-${imageData.timestamp}">
                <label for="select-${imageData.timestamp}">✓</label>
            </div>
        `;

        // Anchor for PhotoSwipe
        const link = document.createElement('a');
        link.href = imageData.url;
        link.className = this.isVideoItem(imageData) ? 'gallery-item-link' : 'pswp-item gallery-item-link';
        link.dataset.endpoint = imageData.endpoint || '';
        link.dataset.prompt = imageData.prompt || '';
        link.dataset.seed = imageData.seed || '';
        link.dataset.meta = JSON.stringify(imageData.parameters || {});
        link.dataset.imageId = imageData.timestamp;
        if (this.isVideoItem(imageData)) {
            link.target = '_blank';
            link.rel = 'noopener';
            link.dataset.mediaType = 'video';
        } else {
            this._assignNaturalSize(link, imageData.url);
        }

        const media = this.createGalleryMediaElement(imageData, 'Saved image');

        const info = document.createElement('div');
        info.className = 'gallery-item-info';
        info.innerHTML = `
            <div>${imageData.endpoint}</div>
            <div>${date}</div>
        `;

        // Add selection event listeners
        const checkbox = selectionOverlay.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            this.toggleImageSelection(imageData.timestamp, e.target.checked);
        });

        // Add click handler for selection mode
        div.addEventListener('click', (e) => {
            if (this.selectionMode) {
                e.preventDefault();
                e.stopPropagation();
                checkbox.checked = !checkbox.checked;
                this.toggleImageSelection(imageData.timestamp, checkbox.checked);
            }
        });

        // Add context menu event handlers
        this.addContextMenuEvents(div, imageData);

        link.appendChild(media);
        div.appendChild(selectionOverlay);
        div.appendChild(link);
        div.appendChild(info);

        // Always add like indicator area (visible only when liked, but always clickable)
        const likeIndicator = document.createElement('div');
        likeIndicator.className = 'like-indicator';
        likeIndicator.style.display = isLiked ? 'flex' : 'none';
        likeIndicator.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8.106 18.247C5.298 16.083 2 13.542 2 9.137 2 6.386 4.386 4 7.137 4c1.323 0 2.617.613 3.617 1.553L12 6.998l1.246-1.445C14.246 4.613 15.54 4 16.863 4 19.614 4 22 6.386 22 9.137c0 4.405-3.298 6.946-6.106 9.11L12 21.35l-3.894-3.103Z"/></svg>';
        
        // Add click handler for like toggle
        likeIndicator.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleLike(imageData.timestamp);
        });

        // Add invisible click area for easier clicking when not liked
        const clickArea = document.createElement('div');
        clickArea.style.position = 'absolute';
        clickArea.style.top = '8px';
        clickArea.style.left = '8px';
        clickArea.style.width = '32px';
        clickArea.style.height = '32px';
        clickArea.style.zIndex = '9';
        clickArea.style.cursor = 'pointer';
        clickArea.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleLike(imageData.timestamp);
        });

        div.appendChild(clickArea);
        div.appendChild(likeIndicator);

        return div;
    }

    // Create result image item (PhotoSwipe)
    createResultImageItem(imageUrl, metadata = {}) {
        const div = document.createElement('div');
        div.className = 'result-image';

        const link = document.createElement('a');
        link.href = imageUrl;
        link.className = 'pswp-item';
        link.dataset.endpoint = metadata.endpoint || '';
        link.dataset.prompt = metadata.prompt || (document.getElementById('prompt')?.value || '').trim();
        link.dataset.seed = metadata.seed || '';
        link.dataset.meta = JSON.stringify(metadata.parameters || {});
        this._assignNaturalSize(link, imageUrl);

        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = 'Generated image';
        img.loading = 'lazy';

        // Action buttons overlay
        const actions = document.createElement('div');
        actions.className = 'result-image-actions';

        link.appendChild(img);
        div.appendChild(link);
        div.appendChild(actions);

        return div;
    }

    // Update mobile gallery content
    updateMobileGallery() {
        const container = document.getElementById('mobile-gallery-content');

        if (!container) return;

        container.innerHTML = '';

        if (this.savedImages.length === 0) {
            container.innerHTML = '<div class="text-center" style="grid-column: 1/-1; padding: 2rem; color: #6b7280;">No saved images yet</div>';
        } else {
            this.savedImages.forEach((image, index) => {
                const item = this.createMobileGalleryItem(image, index);
                container.appendChild(item);
            });
        }

        // Update like indicators after DOM update
        requestAnimationFrame(() => {
            this.updateGalleryLikes();
        });

        // After DOM updates recalc sticky offsets
        this.updateMobileStickyHeights();
    }

    // Recalculate and store heights used for sticky positioning (CSS variables)
    updateMobileStickyHeights() {
        const galleryEl = document.getElementById('mobile-gallery');
        if (!galleryEl) return;
        const header = galleryEl.querySelector('.mobile-gallery-header');
        const meta = galleryEl.querySelector('.mobile-gallery-meta');
        if (header) {
            const h = header.getBoundingClientRect().height;
            galleryEl.style.setProperty('--mobile-gallery-header-height', h + 'px');
        }
        if (meta) {
            const m = meta.getBoundingClientRect().height;
            galleryEl.style.setProperty('--mobile-gallery-meta-height', m + 'px');
        }
    }

    // Create mobile gallery item
    createMobileGalleryItem(imageData, index) {
        const div = document.createElement('div');
        div.className = 'gallery-item';
        div.setAttribute('data-image-id', imageData.timestamp); // Unique identifier

        // Check if liked and add class
        const isLiked = this.likedImages.includes(String(imageData.timestamp));
        if (isLiked) {
            div.classList.add('liked');
        }

        const date = new Date(imageData.timestamp).toLocaleDateString();

        // Selection checkbox
        const selectionOverlay = document.createElement('div');
        selectionOverlay.className = 'gallery-item-selection';
        selectionOverlay.innerHTML = `
            <div class="selection-checkbox">
                <input type="checkbox" id="select-mobile-${imageData.timestamp}">
                <label for="select-mobile-${imageData.timestamp}">✓</label>
            </div>
        `;

        const link = document.createElement('a');
        link.href = imageData.url;
        link.className = this.isVideoItem(imageData) ? 'gallery-item-link' : 'pswp-item gallery-item-link';
        link.dataset.endpoint = imageData.endpoint || '';
        link.dataset.prompt = imageData.prompt || '';
        link.dataset.seed = imageData.seed || '';
        link.dataset.meta = JSON.stringify(imageData.parameters || {});
        link.dataset.imageId = imageData.timestamp;
        if (this.isVideoItem(imageData)) {
            link.target = '_blank';
            link.rel = 'noopener';
            link.dataset.mediaType = 'video';
        } else {
            this._assignNaturalSize(link, imageData.url);
        }

        const media = this.createGalleryMediaElement(imageData, 'Saved image');

        // Add selection event listeners
        const checkbox = selectionOverlay.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            this.toggleImageSelection(imageData.timestamp, e.target.checked);
        });

        // Add click handler for selection mode
        div.addEventListener('click', (e) => {
            if (this.selectionMode) {
                e.preventDefault();
                e.stopPropagation();
                checkbox.checked = !checkbox.checked;
                this.toggleImageSelection(imageData.timestamp, checkbox.checked);
            }
        });

        // Add context menu event handlers
        this.addContextMenuEvents(div, imageData);

        link.appendChild(media);
        div.appendChild(selectionOverlay);
        div.appendChild(link);

        // Always add like indicator area (visible only when liked, but always clickable)
        const likeIndicator = document.createElement('div');
        likeIndicator.className = 'like-indicator';
        likeIndicator.style.display = isLiked ? 'flex' : 'none';
        likeIndicator.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8.106 18.247C5.298 16.083 2 13.542 2 9.137 2 6.386 4.386 4 7.137 4c1.323 0 2.617.613 3.617 1.553L12 6.998l1.246-1.445C14.246 4.613 15.54 4 16.863 4 19.614 4 22 6.386 22 9.137c0 4.405-3.298 6.946-6.106 9.11L12 21.35l-3.894-3.103Z"/></svg>';
        
        // Add click handler for like toggle
        likeIndicator.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleLike(imageData.timestamp);
        });

        // Add invisible click area for easier clicking when not liked
        const clickArea = document.createElement('div');
        clickArea.style.position = 'absolute';
        clickArea.style.top = '8px';
        clickArea.style.left = '8px';
        clickArea.style.width = '32px';
        clickArea.style.height = '32px';
        clickArea.style.zIndex = '9';
        clickArea.style.cursor = 'pointer';
        clickArea.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleLike(imageData.timestamp);
        });

        div.appendChild(clickArea);
        div.appendChild(likeIndicator);

        return div;
    }

    // (no lightbox re-init needed for PhotoSwipe)

    // Save image to gallery (auto use, dedupe, silent optional)
    saveImage(imageUrl, metadata = {}, options = {}) {
        const { dedupe = true, silent = false } = options;
        if (dedupe && this.savedImages.some(img => img.url === imageUrl)) {
            return false; // already stored
        }
        // Use prompt from metadata if provided, otherwise fall back to form input
        const promptValue = metadata.prompt || (document.getElementById('prompt')?.value || '').trim();
        const imageData = {
            url: imageUrl,
            timestamp: Date.now(),
            endpoint: metadata.endpoint || 'Unknown',
            parameters: metadata.parameters || {},
            prompt: promptValue,
            ...metadata
        };
        this.savedImages.unshift(imageData);
        this.saveImages();
        this.showInlineGallery();
        this.updateMobileGallery();
        if (!silent && this.app && this.app.showNotification) {
            this.app.showNotification('Image added to gallery', 'success');
        }
        return true;
    }

    // Save images to localStorage
    saveImages() {
        try {
            localStorage.setItem('falai_saved_images', JSON.stringify(this.savedImages));
        } catch (e) {
            console.warn('Failed to save gallery (likely quota exceeded)', e);
            // Try freeing space by removing oldest images until it fits or list empty
            let removed = 0;
            while (this.savedImages.length > 0) {
                this.savedImages.pop(); // remove oldest (we unshift new ones)
                try {
                    localStorage.setItem('falai_saved_images', JSON.stringify(this.savedImages));
                    if (this.app && this.app.showNotification) {
                        this.app.showNotification(`Storage full. Removed ${removed + 1}+ old images to save new ones`, 'warning');
                    }
                    return;
                } catch (err) {
                    removed++;
                    continue;
                }
            }
            if (this.app && this.app.showNotification) {
                this.app.showNotification('Storage full. Failed to save image.', 'error');
            } else {
                alert('Storage full. Failed to save image.');
            }
        }
    }

    // Save likes to localStorage
    saveLikes() {
        try {
            localStorage.setItem('falai_liked_images', JSON.stringify(this.likedImages));
        } catch (e) {
            console.warn('Failed to save likes', e);
        }
    }

    // Toggle like state for an image
    toggleLike(imageId) {
        const imageIdStr = String(imageId);
        const index = this.likedImages.indexOf(imageIdStr);
        
        if (index > -1) {
            // Remove from likes
            this.likedImages.splice(index, 1);
        } else {
            // Add to likes
            this.likedImages.push(imageIdStr);
        }
        
        this.saveLikes();
        this.updateGalleryLikes();
        
        return this.likedImages.includes(imageIdStr);
    }

    // Find or save result image and return its ID for syncing with PhotoSwipe
    findOrSaveResultImage(imageUrl, metadata = {}) {
        // Try to find existing saved image with this URL
        const existingImage = this.savedImages.find(img => img.url === imageUrl);
        if (existingImage) {
            return existingImage.timestamp;
        }

        // If it's a result image being liked, save it to gallery
        const imageData = {
            url: imageUrl,
            timestamp: Date.now(),
            endpoint: metadata.endpoint || 'Unknown',
            parameters: metadata.parameters || {},
            prompt: metadata.prompt || '',
            ...metadata
        };
        
        this.savedImages.unshift(imageData);
        this.saveImages();
        this.showInlineGallery();
        this.updateMobileGallery();
        
        return imageData.timestamp;
    }

    // Update gallery display to show like states
    updateGalleryLikes() {
        const galleryItems = document.querySelectorAll('.gallery-item');
        galleryItems.forEach(item => {
            const link = item.querySelector('a[data-image-id]');
            if (link) {
                const imageId = String(link.dataset.imageId);
                const isLiked = this.likedImages.includes(imageId);
                item.classList.toggle('liked', isLiked);

                // Show/hide like indicator based on like state
                const likeIndicator = item.querySelector('.like-indicator');
                if (likeIndicator) {
                    likeIndicator.style.display = isLiked ? 'flex' : 'none';
                }
            }
        });
    }

    // Clean up old images (called by app cleanup utility)
    cleanupOldGalleryImages(daysOld = 30) {
        const cutoffDate = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
        const initialCount = this.savedImages.length;

        this.savedImages = this.savedImages.filter(image => image.timestamp > cutoffDate);

        if (this.savedImages.length < initialCount) {
            this.saveImages();
            this.showInlineGallery();
            this.updateMobileGallery();
        }

        return initialCount - this.savedImages.length;
    }

    // Clean base64 images from gallery
    cleanGalleryBase64() {
        const initialCount = this.savedImages.length;
        this.savedImages = this.savedImages.filter(image => !image.url.startsWith('data:'));

        if (this.savedImages.length < initialCount) {
            this.saveImages();
            this.showInlineGallery();
            this.updateMobileGallery();
        }

        return initialCount - this.savedImages.length;
    }

    // Analyze gallery for storage info
    analyzeGallery() {
        const stats = {
            totalImages: this.savedImages.length,
            totalSize: 0,
            oldestImage: null,
            newestImage: null,
            endpointBreakdown: {}
        };

        if (this.savedImages.length > 0) {
            stats.oldestImage = new Date(Math.min(...this.savedImages.map(img => img.timestamp)));
            stats.newestImage = new Date(Math.max(...this.savedImages.map(img => img.timestamp)));

            // Calculate approximate size and endpoint breakdown
            this.savedImages.forEach(image => {
                // Estimate size for base64 images
                if (image.url.startsWith('data:')) {
                    const base64Data = image.url.split(',')[1];
                    stats.totalSize += (base64Data.length * 3) / 4; // Approximate byte size
                }

                // Count by endpoint
                const endpoint = image.endpoint || 'Unknown';
                stats.endpointBreakdown[endpoint] = (stats.endpointBreakdown[endpoint] || 0) + 1;
            });
        }

        return stats;
    }

    // Clear all gallery images
    clearGallery() {
        if (confirm('Are you sure you want to clear all saved images? This action cannot be undone.')) {
            this.savedImages = [];
            this.selectedImages.clear();
            this.saveImages();
            this.showInlineGallery();
            this.updateMobileGallery();

            if (this.app && this.app.showNotification) {
                this.app.showNotification('Gallery cleared', 'success');
            }
        }
    }

    // Toggle selection mode
    toggleSelectionMode() {
        this.selectionMode = !this.selectionMode;
        this.selectedImages.clear();

        // Update both inline and mobile gallery containers
        const galleryContainer = document.getElementById('inline-gallery');
        const mobileGalleryContainer = document.getElementById('mobile-gallery');

        if (galleryContainer) {
            galleryContainer.classList.toggle('selection-mode', this.selectionMode);
        }

        if (mobileGalleryContainer) {
            mobileGalleryContainer.classList.toggle('selection-mode', this.selectionMode);
        }

        this.updateSelectionUI();
        this.showInlineGallery(); // Refresh to show/hide checkboxes
        this.updateMobileGallery(); // Refresh mobile gallery too
    }

    // Toggle individual image selection
    toggleImageSelection(imageId, selected) {
        if (selected) {
            this.selectedImages.add(imageId);
        } else {
            this.selectedImages.delete(imageId);
        }

        this.updateSelectionUI();
        this.updateGalleryItemSelection(imageId, selected);
    }

    // Update gallery item visual selection state
    updateGalleryItemSelection(imageId, selected) {
        const galleryItem = document.querySelector(`[data-image-id="${imageId}"]`);
        if (galleryItem) {
            galleryItem.classList.toggle('selected', selected);
        }
    }

    // Update selection UI (count, buttons, etc.)
    updateSelectionUI() {
        const selectionCount = this.selectedImages.size;

        // Show/hide selection action rows
        document.querySelectorAll('.selection-actions-row').forEach(row => {
            row.style.display = this.selectionMode ? 'block' : 'none';
        });

        // Show/hide inline action buttons
        document.querySelectorAll('.gallery-inline-actions').forEach(container => {
            const counter = container.querySelector('.selection-counter');
            const selectAllBtn = container.querySelector('.select-all-btn');
            const selectNotLikedBtn = container.querySelector('.select-not-liked-btn');
            const clearBtn = container.querySelector('.clear-selection-btn');
            const deleteBtn = container.querySelector('.bulk-delete-btn');

            // Update counter and selection mode button
            if (counter) {
                counter.style.display = this.selectionMode ? 'inline-block' : 'none';
                counter.textContent = `${selectionCount} selected`;
            }

            // Update buttons in selection actions row
            if (container.classList.contains('selection-actions-row')) {
                if (deleteBtn) deleteBtn.style.display = selectionCount > 0 ? 'inline-block' : 'none';
            }
        });
    }

    // Select all images
    selectAllImages() {
        this.selectedImages.clear();
        this.savedImages.forEach(image => {
            this.selectedImages.add(image.timestamp);
        });

        // Update all checkboxes
        const checkboxes = document.querySelectorAll('.gallery-item input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            checkbox.checked = true;
        });

        // Update visual state
        const galleryItems = document.querySelectorAll('.gallery-item');
        galleryItems.forEach(item => {
            item.classList.add('selected');
        });

        this.updateSelectionUI();
    }

    // Clear all selections
    clearSelection() {
        this.selectedImages.clear();

        // Update all checkboxes
        const checkboxes = document.querySelectorAll('.gallery-item input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            checkbox.checked = false;
        });

        // Update visual state
        const galleryItems = document.querySelectorAll('.gallery-item');
        galleryItems.forEach(item => {
            item.classList.remove('selected');
        });

        this.updateSelectionUI();
    }

    // Select only not-liked images (for deletion)
    selectNotLikedImages() {
        this.clearSelection();

        // Only select images that are NOT liked
        const galleryItems = document.querySelectorAll('.gallery-item');
        galleryItems.forEach(item => {
            const link = item.querySelector('a[data-image-id]');
            if (link) {
                const imageId = link.dataset.imageId;
                const isLiked = this.likedImages.includes(imageId);

                if (!isLiked) {
                    const checkbox = item.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        checkbox.checked = true;
                        this.selectedImages.add(Number(imageId));
                        item.classList.add('selected');
                    }
                }
            }
        });

        this.updateSelectionUI();
    }

    // Bulk delete selected images
    bulkDeleteImages() {
        const selectedCount = this.selectedImages.size;
        if (selectedCount === 0) return;

        const confirmMessage = `Are you sure you want to delete ${selectedCount} selected image${selectedCount > 1 ? 's' : ''}? This action cannot be undone.`;

        if (confirm(confirmMessage)) {
            // Remove selected images from savedImages array
            this.savedImages = this.savedImages.filter(image =>
                !this.selectedImages.has(image.timestamp)
            );

            // Clear selection
            this.selectedImages.clear();

            // Save and refresh
            this.saveImages();
            this.showInlineGallery();
            this.updateMobileGallery();
            this.updateSelectionUI();

            if (this.app && this.app.showNotification) {
                this.app.showNotification(`${selectedCount} image${selectedCount > 1 ? 's' : ''} deleted successfully`, 'success');
            }
        }
    }

    // Helper: set intrinsic image size for PhotoSwipe to avoid stretch
    _assignNaturalSize(anchorEl, url) {
        const img = new Image();
        img.onload = () => {
            // Only set if dimensions look valid and not already set
            if (!anchorEl.getAttribute('data-pswp-width')) {
                anchorEl.setAttribute('data-pswp-width', img.naturalWidth);
                anchorEl.setAttribute('data-pswp-height', img.naturalHeight);
            }
        };
        // Use decoding async for faster paint if supported
        try { img.decoding = 'async'; } catch (e) { }
        img.src = url;
    }
}

// Export for use in main app
if (typeof module !== 'undefined' && module.exports) {
    module.exports = FalAIGallery;
}
