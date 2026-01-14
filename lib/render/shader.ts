export type GLProgramBundle = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  aPos: number;
  uMvp: WebGLUniformLocation;
  uColor: WebGLUniformLocation;
};

export function createProgram(gl: WebGLRenderingContext): GLProgramBundle {
  const vertexShader = `
    precision highp float;
    attribute vec3 a_pos;
    uniform mat4 u_mvp;

    void main() {
      vec4 pos = u_mvp * vec4(a_pos, 1.0);

      if (pos.w < 0.2) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // Outside NDC
        return;
      }

      gl_Position = pos;
    }
  `;

  const fs = `
    precision mediump float;
    uniform vec3 u_color;
    void main() {
      gl_FragColor = vec4(u_color, 1.0);
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
    uMvp: gl.getUniformLocation(prog, "u_mvp")!,
    uColor: gl.getUniformLocation(prog, "u_color")!,
  };
}
