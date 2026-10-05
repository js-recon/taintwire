import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
    title: "taintwire",
    tagline: "Graph-based AST and taint analysis for JavaScript",

    url: "https://js-recon.github.io",
    baseUrl: "/taintwire/",

    onBrokenLinks: "throw",
    markdown: {
        // .md is plain CommonMark, so `{` and `<` in prose don't need escaping; use .mdx for JSX.
        format: "detect",
        hooks: { onBrokenMarkdownLinks: "throw" },
    },

    presets: [
        [
            "@docusaurus/preset-classic",
            {
                docs: {
                    routeBasePath: "/",
                    sidebarPath: "./sidebars.ts",
                    editUrl: "https://github.com/js-recon/taintwire/edit/main/docs/",
                },
                blog: false,
            } satisfies Preset.Options,
        ],
    ],

    themeConfig: {
        navbar: {
            title: "taintwire",
            items: [
                { type: "docSidebar", sidebarId: "apiSidebar", position: "left", label: "API" },
                { type: "docSidebar", sidebarId: "implementationSidebar", position: "left", label: "Implementation" },
                { href: "https://github.com/js-recon/taintwire", label: "GitHub", position: "right" },
            ],
        },
        footer: {
            style: "dark",
            copyright: `Copyright © ${new Date().getFullYear()} Shriyans Sudhi. Built with Docusaurus.`,
        },
        colorMode: { defaultMode: "dark" },
        prism: { additionalLanguages: ["cypher", "bash"] },
    } satisfies Preset.ThemeConfig,
};

export default config;
