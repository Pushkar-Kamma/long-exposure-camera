const vertexSource = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const stackSource = `#version 300 es
precision highp float;
uniform sampler2D previous;
uniform sampler2D frame;
uniform int first;
uniform int trails;
uniform vec2 offset;
in vec2 uv;
out vec4 color;
vec3 linearize(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 readLinear(ivec2 point) {
  ivec2 size = textureSize(frame, 0);
  return linearize(texelFetch(frame, clamp(point, ivec2(0), size - 1), 0).rgb);
}
vec3 shiftedSample(vec2 point) {
  if (all(equal(offset, vec2(0.0)))) return linearize(texture(frame, point).rgb);
  vec2 position = point * vec2(textureSize(frame, 0)) - 0.5;
  ivec2 base = ivec2(floor(position));
  vec2 fraction = fract(position);
  return mix(mix(readLinear(base), readLinear(base + ivec2(1, 0)), fraction.x),
             mix(readLinear(base + ivec2(0, 1)), readLinear(base + ivec2(1, 1)), fraction.x), fraction.y);
}
void main() {
  vec4 old = first == 1 ? vec4(0.0) : texture(previous, uv);
  vec2 sourcePoint = uv + offset;
  if (any(lessThan(sourcePoint, vec2(0.0))) || any(greaterThanEqual(sourcePoint, vec2(1.0)))) {
    color = old;
    return;
  }
  vec3 incoming = shiftedSample(sourcePoint);
  color = vec4(trails == 1 ? max(old.rgb, incoming) : old.rgb + incoming, old.a + 1.0);
}`;

const displaySource = `#version 300 es
precision highp float;
uniform sampler2D image;
uniform int average;
uniform float exposure;
in vec2 uv;
out vec4 color;
vec3 encode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec4 sampleValue = texture(image, uv);
  float divisor = average == 1 ? max(sampleValue.a, 1.0) : 1.0;
  vec3 linear = max(sampleValue.rgb / divisor * exp2(exposure), vec3(0.0));
  color = vec4(clamp(encode(linear), 0.0, 1.0), 1.0);
}`;

export class FrameStacker {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: 'high-performance'
    });
    if (!this.gl || !this.gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This browser cannot run the high-precision photo stacker. Use up-to-date Safari on your iPhone.');
    }
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    this.stackProgram = this.program(vertexSource, stackSource);
    this.displayProgram = this.program(vertexSource, displaySource);
    this.stackUniforms = Object.fromEntries(['previous', 'frame', 'first', 'trails', 'offset'].map(name => [name, gl.getUniformLocation(this.stackProgram, name)]));
    this.displayUniforms = Object.fromEntries(['image', 'average', 'exposure'].map(name => [name, gl.getUniformLocation(this.displayProgram, name)]));
    this.targets = [];
    this.input = null;
    this.frames = 0;
  }

  program(vertex, fragment) {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Photo shader failed: ${message}`);
      }
      return shader;
    };
    const v = compile(gl.VERTEX_SHADER, vertex);
    const f = compile(gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.linkProgram(program);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Photo renderer failed: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  texture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  reset(width, height, mode) {
    if (!['average', 'trails'].includes(mode)) throw new Error('Unknown stacking mode.');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('Camera has not supplied a usable image size.');
    }
    this.releaseImages();
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('The photo renderer was interrupted. Reload the app.');
    this.canvas.width = width;
    this.canvas.height = height;
    this.mode = mode;
    this.frames = 0;
    this.current = 0;
    gl.viewport(0, 0, width, height);
    this.input = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (let i = 0; i < 2; i++) {
      const texture = this.texture();
      // A float32 sum avoids the precision freeze of float16 running averages on long shots.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
      const framebuffer = gl.createFramebuffer();
      this.targets.push({ texture, framebuffer });
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.releaseImages();
        throw new Error('Not enough graphics memory for this shot. Try 720p quality.');
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  add(source, { x = 0, y = 0 } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) >= this.canvas.width || Math.abs(y) >= this.canvas.height) {
      throw new Error('The frame alignment is outside the image. Hold the phone still and start a new exposure.');
    }
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('The photo renderer was interrupted. Reload the app.');
    const next = 1 - this.current;
    gl.useProgram(this.stackProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[next].framebuffer);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.current].texture);
    gl.uniform1i(this.stackUniforms.previous, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.input);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(this.stackUniforms.frame, 1);
    gl.uniform1i(this.stackUniforms.first, this.frames === 0 ? 1 : 0);
    gl.uniform1i(this.stackUniforms.trails, this.mode === 'trails' ? 1 : 0);
    gl.uniform2f(this.stackUniforms.offset, x / this.canvas.width, -y / this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.current = next;
    this.frames++;
  }

  render(exposure = 0) {
    if (!this.frames) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.displayProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.current].texture);
    gl.uniform1i(this.displayUniforms.image, 0);
    // The alpha channel counts observations per pixel, so shifted borders never darken.
    gl.uniform1i(this.displayUniforms.average, this.mode === 'average' ? 1 : 0);
    gl.uniform1f(this.displayUniforms.exposure, exposure);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  releaseImages() {
    for (const target of this.targets) {
      this.gl.deleteTexture(target.texture);
      this.gl.deleteFramebuffer(target.framebuffer);
    }
    this.targets = [];
    if (this.input) this.gl.deleteTexture(this.input);
    this.input = null;
    this.frames = 0;
  }

  dispose() {
    this.releaseImages();
    this.gl.deleteProgram(this.stackProgram);
    this.gl.deleteProgram(this.displayProgram);
  }
}
