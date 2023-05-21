(function(Scratch) {
  'use strict';

  // This extension was created by making projects with https://lab.scratch.mit.edu/text/
  // To determine block and argument IDs, we extracted project.json and examined the result.
  // To determine block behaviors we simply experiment with Scratch Labs and made sure our
  // blocks do the same things.
  // This extension's code is not based on the source code of Scratch Labs.

  const CUSTOM_STATE_KEY = Symbol();

  const ALIGN_LEFT = 0;
  const ALIGN_RIGHT = 1;
  const ALIGN_CENTER = 2;

  const vm = Scratch.vm;
  const renderer = vm.renderer;
  const gl = renderer.gl;

  const NATIVE_FONTS = [
    'Sans Serif',
    'Serif',
    'Handwriting',
    'Marker',
    'Curly',
    'Pixel',
  ];

  const DEFAULT_COLOR = '#575E75';
  const DEFAULT_FONT = 'Handwriting';
  const DEFAULT_WIDTH = vm.runtime.stageWidth;
  const DEFAULT_ALIGN = ALIGN_CENTER;
  const DEFAULT_FONT_SIZE = 24;
  const DEFAULT_SPACE_BETWEEN_LINES = 3;

  const TYPE_DELAY = 1000 / 30;

  const RAINBOW_TIME_PER = 1000;
  const RAINBOW_DURATION = 2000;

  const ZOOM_DURATION = 500;

  /**
   * @typedef TextState
   * @property {TextCostumeSkin} skin
   */

  /** @type {typeof RenderWebGL.Skin} */
  // @ts-expect-error - exports not typed yet
  const Skin = renderer.exports.Skin;
  /** @type {typeof RenderWebGL.CanvasMeasurementProvider} */
  // @ts-expect-error - exports not typed yet
  const CanvasMeasurementProvider = renderer.exports.CanvasMeasurementProvider;
  // @ts-expect-error - exports not typed yet
  const twgl = renderer.exports.twgl;

  /**
   * @param {number} c
   * @returns {string}
   */
  const formatComponent = (c) => Math.round(c).toString(16).padStart(2, '0');

  /**
   * @param {[number, number, number]} color
   * @returns {string}
   */
  const formatColor = (color) => `#${formatComponent(color[0])}${formatComponent(color[1])}${formatComponent(color[2])}`;

  /**
   * @param {number} h hue from 0-1. must be positive
   * @param {number} s saturation from 0-1
   * @param {number} v value from 0-1
   * @returns {[number, number, number]} RGB channels from 0-255
   */
  const hsvToRGB = (h, s, v) => {
    // https://en.wikipedia.org/wiki/HSL_and_HSV
    var r, g, b;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    switch (i % 6) {
      case 0: r = v, g = t, b = p; break;
      case 1: r = q, g = v, b = p; break;
      case 2: r = p, g = v, b = t; break;
      case 3: r = p, g = q, b = v; break;
      case 4: r = t, g = p, b = v; break;
      case 5: r = v, g = p, b = q; break;
    }
    return [r * 255 | 0, g * 255 | 0, b * 255 | 0];
  };

  /**
   * @param {CanvasGradient} gradient
   * @param {number} offset number of cycles to offset by
   */
  const addRainbowStops = (gradient, offset) => {
    // Scratch's gradient still looks better for some reason.
    const NUMBER_STOPS = 20;
    for (let i = 0; i < NUMBER_STOPS; i++) {
      const exactPosition = i / NUMBER_STOPS;
      let offsetPosition = (exactPosition - offset) % 1;
      if (offsetPosition < 0) {
        offsetPosition += 1;
      }
      const rgb = hsvToRGB(offsetPosition, 1, 1);
      gradient.addColorStop(exactPosition, formatColor(rgb));
      gradient.addColorStop(exactPosition, formatColor(rgb));
    }
  };

  class TextCostumeSkin extends Skin {
    constructor (id) {
      // @ts-expect-error - constructors not typed yet
      super(id, renderer);

      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');

      this.text = '';
      this.color = DEFAULT_COLOR;
      this.textWidth = DEFAULT_WIDTH;
      this.fontFamily = DEFAULT_FONT;
      this.baseFontSize = DEFAULT_FONT_SIZE;
      this.spaceBetweenLines = DEFAULT_SPACE_BETWEEN_LINES;
      this.align = DEFAULT_ALIGN;

      /** @type {Array<{text: string; width: number;}>} */
      this.lines = [];
      /** @type {[number, number]} */
      this._size = [0, 0];
      /** @type {[number, number]} */
      this._rotationCenter = [0, 0];
      this.calculatedFontSize = this.baseFontSize;

      this.maxDisplayableCharacters = Infinity;
      this.typeAnimationInterval = null;

      this.isRainbow = false;
      this.rainbowStartTime = 0;
      this.rainbowTimeout = null;

      this.isZooming = false;
      this.zoomStartTime = 0;
      this.zoomTimeout = null;

      /** @type {(() => void)|null} */
      this.resolveOngoingAnimation = null;
    }

    // Part of Skin API
    get size () {
      return this._size;
    }

    // Part of Skin API
    get volatile () {
      return this.isRainbow || this.isZooming;
    }

    // Part of Skin API
    dispose () {
      if (this._texture) {
        gl.deleteTexture(this._texture);
        this._texture = null;
      }
      this.canvas = null;
      this.ctx = null;
      super.dispose();
    }

    _getFontStyle () {
      return `${this.calculatedFontSize}px "${this.fontFamily}"`;
    }

    _calculateFontSize () {
      if (this.isZooming) {
        // TODO: it looks like Scratch's animation always starts at least a little visible
        const time = Date.now() - this.zoomStartTime;
        const progress = Math.max(0, Math.min(1, time / ZOOM_DURATION));
        return this.baseFontSize * progress;
      }
      return this.baseFontSize;
    }

    _calculateDimensions () {
      this.calculatedFontSize = this._calculateFontSize();
      this.ctx.font = this._getFontStyle();

      // need to make new ones each time to avoid caching incorrectly across fonts
      // @ts-expect-error - constructors not typed yet
      const measurementProvider = new CanvasMeasurementProvider(this.ctx);
      /** @type {RenderWebGL.TextWrapper} */
      // @ts-expect-error - createTextWrapper not typed yet
      const textWrapper = renderer.createTextWrapper(measurementProvider);

      const lines = textWrapper.wrapText(this.textWidth, this.text);
      this.lines = lines.map(line => {
        const trimmed = line.trimEnd();
        return {
          text: trimmed,
          width: measurementProvider.measureText(trimmed)
        };
      });

      // TODO: we need a lot more padding
      this._size[0] = Math.round(this.textWidth);
      this._size[1] = Math.round(this.lines.length * (this.baseFontSize + this.spaceBetweenLines));

      // TODO: this is wrong. rotation center should actually be horizontally centered at the bottom of the first line?
      this._rotationCenter[0] = this._size[0] / 2;
      this._rotationCenter[1] = this.calculatedFontSize * 0.8;
    }

    _renderAtScale (requestedScale) {
      this._calculateDimensions();

      const canvasWidth = this._size[0];
      const canvasHeight = this._size[1];

      // Renderer's requested scale is accounted for at this point. Do not touch `requestedScale`
      // ever after this point.
      this.canvas.width = Math.ceil(canvasWidth * requestedScale);
      this.canvas.height = Math.ceil(canvasHeight * requestedScale);
      this.ctx.scale(requestedScale, requestedScale);

      const rainbowOffset = this.isRainbow ? (Date.now() - this.rainbowStartTime) / RAINBOW_TIME_PER : 0;
      this.ctx.fillStyle = this.color;
      this.ctx.font = this._getFontStyle();
      let displayedCharacters = 0;
      for (let i = 0; i < this.lines.length; i++) {
        const line = this.lines[i];
        const text = line.text;
        const lineWidth = line.width;

        const displayedText = text.substring(0, this.maxDisplayableCharacters - displayedCharacters);
        displayedCharacters += text.length;

        let xOffset = 0;
        if (this.align === ALIGN_LEFT) {
          // already correct
        } else if (this.align === ALIGN_CENTER) {
          xOffset = Math.round((this.textWidth - lineWidth) / 2);
        } else {
          xOffset = this.textWidth - lineWidth;
        }

        if (this.isRainbow) {
          const gradient = this.ctx.createLinearGradient(xOffset, 0, xOffset + lineWidth, 0);
          addRainbowStops(gradient, rainbowOffset);
          this.ctx.fillStyle = gradient;
        }

        // TODO: something here is wrong
        this.ctx.fillText(
          displayedText,
          xOffset,
          Math.round(i * (this.baseFontSize + this.spaceBetweenLines) + this.baseFontSize * 0.9)
        );
      }

      // TODO: don't recreate when not needed
      this._texture = twgl.createTexture(gl, {
        auto: false,
        wrap: gl.CLAMP_TO_EDGE
      });
      this._setTexture(this.canvas);
    }

    setText (text) {
      this.text = text;
      this._calculateDimensions();
      this.emitWasAltered();
    }

    setColor (color) {
      this.color = color;
      this.emitWasAltered();
    }

    setAlign (align) {
      this.align = align;
      this._calculateDimensions();
      this.emitWasAltered();
    }

    setWidth (width) {
      this.textWidth = width;
      this._calculateDimensions();
      this.emitWasAltered();
    }

    setFontFamily (font) {
      this.fontFamily = font;
      this._calculateDimensions();
      this.emitWasAltered();
    }

    _oneAnimationAtATime (newCallback) {
      this.cancelAnimation();
      return new Promise(resolve => {
        // @ts-expect-error - signature of function does not really matter here.
        this.resolveOngoingAnimation = resolve;
        newCallback(resolve);
      });
    }

    startTypeAnimation () {
      return this._oneAnimationAtATime(resolve => {
        this.maxDisplayableCharacters = 0;

        this.typeAnimationInterval = setInterval(() => {
          this.maxDisplayableCharacters++;
          if (this.maxDisplayableCharacters >= this.text.length) {
            this.maxDisplayableCharacters = Infinity;
            clearInterval(this.typeAnimationInterval);
            resolve();
          }
          this.emitWasAltered();
        }, TYPE_DELAY);
      });
    }

    startRainbowAnimation () {
      return this._oneAnimationAtATime(resolve => {
        this.isRainbow = true;
        this.rainbowStartTime = Date.now();
        this.rainbowTimeout = setTimeout(() => {
          this.isRainbow = false;
          resolve();
          this.emitWasAltered();
        }, RAINBOW_DURATION);
      });
    }

    startZoomAnimation () {
      return this._oneAnimationAtATime(resolve => {
        this.isZooming = true;
        this.zoomStartTime = Date.now();
        this.zoomTimeout = setTimeout(() => {
          this.isZooming = false;
          resolve();
          this.emitWasAltered();
        }, ZOOM_DURATION);
      });
    }

    cancelAnimation () {
      if (this.resolveOngoingAnimation) {
        this.resolveOngoingAnimation();
      }

      this.maxDisplayableCharacters = Infinity;
      clearInterval(this.typeAnimationInterval);

      this.isRainbow = false;
      clearTimeout(this.rainbowTimeout);

      this.isZooming = false;
      clearTimeout(this.zoomTimeout);

      this.emitWasAltered();
    }

    // Part of Skin API
    getTexture (scale) {
      const MAX_SCALE = 10;
      const scaleMax = scale ? Math.max(Math.abs(scale[0]), Math.abs(scale[1])) : 100;
      const calculatedScale = Math.min(MAX_SCALE, scaleMax / 100);
      this._renderAtScale(calculatedScale);
      return this._texture;
    }
  }

  const createTextCostumeSkin = () => {
    const renderer = Scratch.vm.renderer;
    const id = renderer._nextDrawableId++;
    const skin = new TextCostumeSkin(id);
    renderer._allSkins[id] = skin;
    return skin;
  };

  class AnimatedText {
    constructor () {
      vm.runtime.on('PROJECT_START', () => {
        this._hideAllText();
      });

      vm.runtime.on('PROJECT_STOP_ALL', () => {
        this._hideAllText();
      });

      vm.runtime.on('targetWasCreated', (newTarget, originalTarget) => {
        if (originalTarget && this._hasState(originalTarget)) {
          // TODO: creates much unneeded state
          const originalSkin = this._getState(originalTarget).skin;
          const newSkin = this._getState(newTarget).skin;
          newSkin.setAlign(originalSkin.align);
          newSkin.setColor(originalSkin.color);
          newSkin.setFontFamily(originalSkin.fontFamily);
          newSkin.setWidth(originalSkin.textWidth);
          newSkin.setText(originalSkin.text);
          if (renderer._allDrawables[originalTarget.drawableID].skin instanceof TextCostumeSkin) {
            renderer.updateDrawableSkinId(newTarget.drawableID, newSkin.id);
          }
        }
      });

      vm.runtime.on('targetWasRemoved', (target) => {
        if (this._hasState(target)) {
          const state = this._getState(target);
          renderer.destroySkin(state.skin.id);
        }
      });
    }

    getInfo() {
      return {
        id: 'text',
        name: 'Animated Text',
        blocks: [
          {
            opcode: 'setText',
            blockType: Scratch.BlockType.COMMAND,
            text: 'show text [TEXT]',
            arguments: {
              TEXT: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: 'Welcome to my project!'
              }
            }
          },
          {
            opcode: 'animateText',
            blockType: Scratch.BlockType.COMMAND,
            text: '[ANIMATE] text [TEXT]',
            arguments: {
              ANIMATE: {
                type: Scratch.ArgumentType.STRING,
                menu: 'animate',
                defaultValue: 'rainbow'
              },
              TEXT: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: 'Here we go!'
              }
            }
          },
          {
            opcode: 'clearText',
            blockType: Scratch.BlockType.COMMAND,
            text: 'show sprite'
          },
          '---',
          {
            opcode: 'setFont',
            blockType: Scratch.BlockType.COMMAND,
            text: 'set font to [FONT]',
            arguments: {
              FONT: {
                type: Scratch.ArgumentType.STRING,
                menu: 'font'
              }
            }
          },
          {
            opcode: 'setColor',
            blockType: Scratch.BlockType.COMMAND,
            text: 'set text color to [COLOR]',
            arguments: {
              COLOR: {
                type: Scratch.ArgumentType.COLOR
              }
            }
          },
          {
            opcode: 'setWidth',
            blockType: Scratch.BlockType.COMMAND,
            text: 'set width to [WIDTH] aligned [ALIGN]',
            arguments: {
              WIDTH: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: '200'
              },
              ALIGN: {
                type: Scratch.ArgumentType.STRING,
                menu: 'align'
              }
            }
          }
        ],
        menus: {
          // These all need acceptReporters: false for parity with the Scratch Labs version.
          animate: {
            acceptReporters: false,
            items: ['type', 'rainbow', 'zoom']
          },
          font: {
            acceptReporters: false,
            items: [
              ...NATIVE_FONTS,
              {
                text: 'random font',
                value: 'Random'
              }
            ]
          },
          align: {
            acceptReporters: false,
            items: [
              'left',
              'center',
              'right'
            ]
          }
        }
      };
    }

    /**
     * @param {VM.Target} target
     * @returns {TextState}
     */
    _getState (target) {
      const state = target[CUSTOM_STATE_KEY];
      if (!state) {
        /** @type {TextState} */
        const newState = {
          skin: createTextCostumeSkin()
        };
        target[CUSTOM_STATE_KEY] = newState;
        return newState;
      }
      return state;
    }

    /**
     * @param {VM.Target} target
     * @returns {boolean}
     */
    _hasState (target) {
      return !!target[CUSTOM_STATE_KEY];
    }

    _hideAllText () {
      for (const target of vm.runtime.targets) {
        if (this._hasState(target)) {
          this._hideText(target, this._getState(target));
        }
      }
    }

    /**
     * @param {VM.Target} target
     * @param {TextState} state
     */
    _renderText (target, state) {
      state.skin.cancelAnimation();
      renderer.updateDrawableSkinId(target.drawableID, state.skin.id);
    }

    /**
     * @param {VM.Target} target
     * @param {TextState} state
     */
    _hideText (target, state) {
      state.skin.cancelAnimation();
      target.setCostume(target.currentCostume);
    }

    setText ({ TEXT }, util) {
      const state = this._getState(util.target);
      this._renderText(util.target, state);
      state.skin.setText(Scratch.Cast.toString(TEXT));
      // Scratch forces 1 frame delay by returning promise. I think that's silly.
      util.runtime.requestRedraw();
    }

    animateText ({ ANIMATE, TEXT }, util) {
      const state = this._getState(util.target);
      this._renderText(util.target, state);

      state.skin.setText(Scratch.Cast.toString(TEXT));
      state.skin.cancelAnimation();

      if (ANIMATE === 'type') {
        return state.skin.startTypeAnimation();
      } else if (ANIMATE === 'rainbow') {
        return state.skin.startRainbowAnimation();
      } else if (ANIMATE === 'zoom') {
        return state.skin.startZoomAnimation();
      } else {
        // TODO: test what Scratch does here
      }
    }

    clearText (args, util) {
      if (this._hasState(util.target)) {
        const state = this._getState(util.target);
        this._hideText(util.target, state);
      }
      // Scratch forces 1 frame delay by returning promise. I think that's silly.
      util.runtime.requestRedraw();
    }

    setFont ({ FONT }, util) {
      const state = this._getState(util.target);
      if (FONT === 'Random') {
        state.skin.setFontFamily(NATIVE_FONTS[Math.floor(Math.random() * NATIVE_FONTS.length)]);
      } else {
        state.skin.setFontFamily(Scratch.Cast.toString(FONT));
      }
    }

    setColor ({ COLOR }, util) {
      const state = this._getState(util.target);
      state.skin.setColor(Scratch.Cast.toString(COLOR));
    }

    setWidth ({ WIDTH, ALIGN }, util) {
      const state = this._getState(util.target);

      if (ALIGN === 'center') {
        state.skin.setAlign(ALIGN_CENTER);
      } else if (ALIGN === 'right') {
        state.skin.setAlign(ALIGN_RIGHT);
      } else {
        // Scratch treats unknown values as left alignment.
        state.skin.setAlign(ALIGN_LEFT);
      }

      state.skin.setWidth(Scratch.Cast.toNumber(WIDTH));
    }
  }

  Scratch.extensions.register(new AnimatedText());
})(Scratch);
