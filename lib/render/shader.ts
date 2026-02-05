type GLProgramBundle = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  aPos: number;
  aColor: number;
  uMvp: WebGLUniformLocation;
  uColor: WebGLUniformLocation;
};

export function createProgram(gl: WebGLRenderingContext): GLProgramBundle {
  const vertexShader = `
    precision highp float;
    attribute vec3 a_pos;
    attribute vec3 a_color;
    uniform mat4 u_mvp;
    varying highp vec3 v_color;

    void main() {
      vec4 pos = u_mvp * vec4(a_pos, 1.0);

      if (pos.w < 0.2) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // Outside NDC
        return;
      }

      gl_Position = pos;
      v_color = a_color;
    }
  `;

  const fs = `
    precision mediump float;
    varying highp vec3 v_color;
    uniform vec3 u_color;

    void main() {
      vec3 finalColor = length(v_color) > 0.001 ? v_color : u_color;
      gl_FragColor = vec4(finalColor, 0.1);
    }
  `;

  const vShader = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vShader, vertexShader);
  gl.compileShader(vShader);
  if (!gl.getShaderParameter(vShader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(vShader) || "");
  }

  const fShader = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fShader, fs);
  gl.compileShader(fShader);
  if (!gl.getShaderParameter(fShader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(fShader) || "");
  }

  const prog = gl.createProgram()!;
  gl.attachShader(prog, vShader);
  gl.attachShader(prog, fShader);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || "");
  }

  return {
    gl,
    program: prog,
    aPos: gl.getAttribLocation(prog, "a_pos"),
    aColor: gl.getAttribLocation(prog, "a_color"),
    uMvp: gl.getUniformLocation(prog, "u_mvp")!,
    uColor: gl.getUniformLocation(prog, "u_color")!,
  };
}
