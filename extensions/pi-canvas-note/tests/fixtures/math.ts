// Shared regression corpus for the server-side parser and real browser checks.
export const complexFormulas = [
  {
    name: "多行推导与嵌套分式",
    latex: String.raw`\begin{aligned}
\mathcal{L}(\theta)&=\sum_{i=1}^{n}\log p_\theta(x_i)\\
&=\sum_{i=1}^{n}\log\int q_\phi(z\mid x_i)\frac{p_\theta(x_i,z)}{q_\phi(z\mid x_i)}\,dz\\
&\geq\sum_{i=1}^{n}\mathbb{E}_{q_\phi(z\mid x_i)}\!\left[\log\frac{p_\theta(x_i,z)}{q_\phi(z\mid x_i)}\right].
\end{aligned}`,
  },
  {
    name: "分块矩阵与 Schur 补",
    latex: String.raw`\begin{pmatrix}A&B\\C&D\end{pmatrix}^{-1}=\begin{pmatrix}
A^{-1}+A^{-1}BS^{-1}CA^{-1}&-A^{-1}BS^{-1}\\
-S^{-1}CA^{-1}&S^{-1}
\end{pmatrix},\qquad S=D-CA^{-1}B`,
  },
  {
    name: "分段函数与中文说明",
    latex: String.raw`f(x)=\begin{cases}
\dfrac{\sin x}{x},&x\neq0,\\
1,&x=0.
\end{cases}\qquad\underbrace{\lim_{x\to0}f(x)=1}_{\text{在原点连续}}`,
  },
  {
    name: "多重积分与散度定理",
    latex: String.raw`\iiint_{\Omega}\!\left(\frac{\partial F_x}{\partial x}+\frac{\partial F_y}{\partial y}+\frac{\partial F_z}{\partial z}\right)\,dx\,dy\,dz=\iint_{\partial\Omega}\mathbf{F}\cdot\mathbf{n}\,dS`,
  },
  {
    name: "Maxwell 方程组",
    latex: String.raw`\left\{\begin{aligned}
\nabla\cdot\mathbf{E}&=\frac{\rho}{\varepsilon_0},&\nabla\cdot\mathbf{B}&=0,\\
\nabla\times\mathbf{E}&=-\frac{\partial\mathbf{B}}{\partial t},&\nabla\times\mathbf{B}&=\mu_0\mathbf{J}+\mu_0\varepsilon_0\frac{\partial\mathbf{E}}{\partial t}.
\end{aligned}\right.`,
  },
  {
    name: "概率分布与协方差矩阵",
    latex: String.raw`p(\mathbf{x})=\frac{\exp\!\left[-\frac12(\mathbf{x}-\boldsymbol{\mu})^{\mathsf T}\boldsymbol{\Sigma}^{-1}(\mathbf{x}-\boldsymbol{\mu})\right]}{(2\pi)^{d/2}\sqrt{\det\boldsymbol{\Sigma}}},\quad\boldsymbol{\Sigma}\succ0`,
  },
  {
    name: "极限、级数与连分式",
    latex: String.raw`e^x=\lim_{n\to\infty}\left(1+\frac{x}{n}\right)^n=\sum_{k=0}^{\infty}\frac{x^k}{k!},\qquad\varphi=1+\cfrac{1}{1+\cfrac{1}{1+\cfrac{1}{\ddots}}}`,
  },
  {
    name: "量子态、张量积与算符",
    latex: String.raw`\lvert\Psi\rangle=\frac{\lvert0\rangle\otimes\lvert1\rangle-\lvert1\rangle\otimes\lvert0\rangle}{\sqrt2},\quad\langle\Psi\rvert\hat{\rho}\lvert\Psi\rangle=\operatorname{Tr}\!\left(\hat{\rho}\,\lvert\Psi\rangle\langle\Psi\rvert\right)`,
  },
  {
    name: "带编号的优化问题",
    latex: String.raw`\begin{aligned}
\underset{\mathbf{x}\in\mathbb{R}^n}{\operatorname{minimize}}\quad&\frac12\mathbf{x}^{\mathsf T}Q\mathbf{x}+\mathbf{c}^{\mathsf T}\mathbf{x}\\
\text{subject to}\quad&A\mathbf{x}=\mathbf{b},\\
&G\mathbf{x}\leq\mathbf{h}.
\end{aligned}\tag{1}`,
  },
  {
    name: "超长公式局部横向滚动",
    latex:
      String.raw`\mathcal{J}(\theta)=` +
      Array.from(
        { length: 18 },
        (_, i) =>
          String.raw`\underbrace{\frac{\partial^2\mathcal{L}_{${i + 1}}}{\partial\theta_{${i + 1}}^2}+\lambda_{${i + 1}}\lVert\theta_{${i + 1}}\rVert_2^2}_{\text{term }${i + 1}}`,
      ).join("+"),
  },
];
