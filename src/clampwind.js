import postcss from 'postcss';
import { defaultScreens, defaultContainerScreens, formatBreakpointsRegexMatches, formatContainerBreakpointsRegexMatches, convertSortScreens } from './screens.js';
import { extractTwoValidClampArgs, convertToRem, generateClamp } from './utils.js';

const clampwind = (opts = {}) => {
  let rootFontSize = 16;
  let spacingSize = 0.25;
  let customProperties = {};
  let screens = defaultScreens || {};
  let containerScreens = defaultContainerScreens || {};

  let defaultLayerBreakpoints = {};
  let defaultLayerContainerBreakpoints = {};
  let themeLayerBreakpoints = {};
  let themeLayerContainerBreakpoints = {};
  let rootElementBreakpoints = {};
  let rootElementContainerBreakpoints = {};

  // Store PostCSS AST node references for deferred mutation
  const noMediaQueries = [];
  const singleMediaQueries = [];
  const singleContainerQueries = [];
  const doubleNestedMediaQueries = [];
  const doubleNestedContainerQueries = [];

  return {
    postcssPlugin: 'clampwind',
    prepare() {
      return {
        // MARK: Rule
        Rule(rule) {
          // Collect theme variables from :root
          if (rule.selector === ':root') {
            rule.walkDecls(decl => {
              if (decl.prop.startsWith('--breakpoint-')) {
                const key = decl.prop.replace('--breakpoint-', '');
                rootElementBreakpoints[key] = decl.value;
              }
              if (decl.prop.startsWith('--container-')) {
                const key = decl.prop.replace('--container-', '@');
                rootElementContainerBreakpoints[key] = decl.value;
              }
              if (decl.prop === '--text-base' && decl.value.includes('px')) {
                rootFontSize = parseFloat(decl.value);
              }
              if (decl.prop === 'font-size' && decl.value.includes('px')) {
                rootFontSize = parseFloat(decl.value);
              }
              if (decl.prop === '--spacing') {
                spacingSize = parseFloat(convertToRem(decl.value, rootFontSize, spacingSize, customProperties));
              }
              if (decl.prop.startsWith('--')) {
                const value = parseFloat(convertToRem(decl.value, rootFontSize, spacingSize, customProperties));
                if (value) customProperties[decl.prop] = value;
              }
            });
            return;
          }

          // Collect clamp() decl in no-media rules
          const declNodes = [];
          for (const node of rule.nodes || []) {
            if (node.type === 'decl' && extractTwoValidClampArgs(node.value)) {
              declNodes.push(node);
            }
          }

          const hasMediaChild = (rule.nodes || []).some(
            n => n.type === 'atrule' && n.name === 'media'
          );

          // If there are valid clamp() decls and no @media child, add to noMediaQueries
          if (declNodes.length && !hasMediaChild) {
            noMediaQueries.push({ ruleNode: rule, declNodes });
          }
        },

        // MARK: AtRule
        AtRule: {

          // MARK: - - Layers
          // Collect theme variables from layers
          layer(atRule) {
            // Default layer
            if (atRule.params === 'default' && !Object.keys(defaultLayerBreakpoints).length) {
              const css = atRule.source.input.css;
              const matches = css.match(/--breakpoint-[^:]+:\s*[^;]+/g) || [];
              defaultLayerBreakpoints = formatBreakpointsRegexMatches(matches);
            }
            if (atRule.params === 'default' && !Object.keys(defaultLayerContainerBreakpoints).length) {
              const css = atRule.source.input.css;
              const matches = css.match(/--container-[^:]+:\s*[^;]+/g) || [];
              defaultLayerContainerBreakpoints = formatContainerBreakpointsRegexMatches(matches);
            }
            // Theme layer
            if (atRule.params === 'theme') {
              atRule.walkDecls(decl => {
                if (decl.prop.startsWith('--breakpoint-')) {
                  const key = decl.prop.replace('--breakpoint-', '');
                  themeLayerBreakpoints[key] = decl.value;
                }
                if (decl.prop.startsWith('--container-')) {
                  const key = decl.prop.replace('--container-', '@');
                  themeLayerContainerBreakpoints[key] = decl.value;
                }
                if (decl.prop === '--text-base' && decl.value.includes('px')) {
                  rootFontSize = parseFloat(decl.value);
                }
                if (decl.prop === '--spacing') {
                  spacingSize = parseFloat(convertToRem(decl.value, rootFontSize, spacingSize, customProperties));
                }
                if (decl.prop.startsWith('--')) {
                  const value = parseFloat(convertToRem(decl.value, rootFontSize, spacingSize, customProperties));
                  if (value) customProperties[decl.prop] = value;
                }
              });
            }
          },

          // MARK: - - Media
          // Collect clamp() decls from single @media and nested @media
          media(atRule) {
            const isNested = atRule.parent?.type === 'atrule';
            const isSameAtRule = atRule.parent?.name === atRule.name;

            const declNodes = [];
            for (const node of atRule.nodes || []) {
              if (node.type === 'decl' && extractTwoValidClampArgs(node.value)) {
                declNodes.push(node);
              }
            }
            if (!declNodes.length) return;

            if (isNested && isSameAtRule) {
              doubleNestedMediaQueries.push({
                parentNode: atRule.parent,
                mediaNode: atRule,
                declNodes
              });
            } else if (isNested && !isSameAtRule) {
              declNodes.forEach(decl => {
                decl.value = ` ${decl.value} /* Invalid nested @media and @container rules */`;
              });
            } else {
              singleMediaQueries.push({ mediaNode: atRule, declNodes });
            }
          },

          // MARK: - - Container
          // Collect clamp() decls from single @container and nested @container
          container(atRule) {
            const isNested = atRule.parent?.type === 'atrule';
            const isSameAtRule = atRule.parent?.name === atRule.name;

            const declNodes = [];
            for (const node of atRule.nodes || []) {
              if (node.type === 'decl' && extractTwoValidClampArgs(node.value)) {
                declNodes.push(node);
              }
            }
            if (!declNodes.length) return;

            if (isNested && isSameAtRule) {
              doubleNestedContainerQueries.push({
                parentNode: atRule.parent,
                mediaNode: atRule,
                declNodes
              });
            } else if (isNested && !isSameAtRule) {
              declNodes.forEach(decl => {
                decl.value = ` ${decl.value} /* Invalid nested @media and @container rules */`;
              });
            } else {
              singleContainerQueries.push({ mediaNode: atRule, declNodes });
            }
          }
        },

        // MARK: OnceExit
        OnceExit() {
          // Join, convert and sort screens breakpoints from theme, root and layer
          screens = Object.assign(
            {},
            screens,
            defaultLayerBreakpoints,
            rootElementBreakpoints,
            themeLayerBreakpoints
          );
          screens = convertSortScreens(screens, rootFontSize,);

          // Join, convert and sort container breakpoints from theme, root and layer
          containerScreens = Object.assign(
            {},
            containerScreens,
            defaultLayerContainerBreakpoints,
            rootElementContainerBreakpoints,
            themeLayerContainerBreakpoints
          );
          containerScreens = convertSortScreens(containerScreens, rootFontSize);

          // MARK: - - No MQ
          // No-media rules: generate clamp from smallest to largest breakpoint
          noMediaQueries.forEach(({ ruleNode, declNodes }) => {
            declNodes.forEach(decl => {

              const args = extractTwoValidClampArgs(decl.value);
              const [lower, upper] = args.map(val => convertToRem(val, rootFontSize, spacingSize, customProperties));
              if (!args || !lower || !upper) {
                decl.value = ` ${decl.value} /* Invalid clamp() values */`;
                return;
              }

              const screenValues = Object.values(screens);
              const minScreen = screenValues[0];
              const maxScreen = screenValues[screenValues.length - 1];

              const clamp = generateClamp(lower, upper, minScreen, maxScreen, rootFontSize, spacingSize)
              ruleNode.append(postcss.decl({ prop: decl.prop, value: clamp }));

              decl.remove();
            });
          });

          // MARK: - - Single MQ
          // Single media queries: generate clamp from the defined media query breakpoint to the smallest or largest breakpoint depending on the direction
          singleMediaQueries.forEach(({ mediaNode, declNodes }) => {
            const newMediaQueries = [];
            
            declNodes.forEach(decl => {

              const args = extractTwoValidClampArgs(decl.value);
              const [lower, upper] = args.map(val => convertToRem(val, rootFontSize, spacingSize, customProperties));
              if (!args || !lower || !upper) {
                decl.value = ` ${decl.value} /* Invalid clamp() values */`;
                return;
              }

              const screenValues = Object.values(screens);              
              
              // 1) Create upper breakpoints 
              if (mediaNode.params.includes('>')) {

                const minScreen = mediaNode.params.match(/>=?([^)]+)/)[1].trim()
                const maxScreen = screenValues[screenValues.length - 1];

                const singleMQ = postcss.atRule({ name: 'media', params: `(width >= ${minScreen})` });
                const clamp = generateClamp(lower, upper, minScreen, maxScreen, rootFontSize, spacingSize)

                singleMQ.append(postcss.decl({ prop: decl.prop, value: clamp }));
                newMediaQueries.push(singleMQ);

                decl.remove();

              } else if (mediaNode.params.includes('<')) {
                // 2) Create lower breakpoints

                const minScreen = screenValues[0];
                const maxScreen = mediaNode.params.match(/<([^)]+)/)[1].trim()

                const singleMQ = postcss.atRule({ name: 'media', params: mediaNode.params });
                const clamp = generateClamp(lower, upper, minScreen, maxScreen, rootFontSize, spacingSize)
                
                singleMQ.append(postcss.decl({ prop: decl.prop, value: clamp }));
                newMediaQueries.push(singleMQ);

                decl.remove();

              }
            });
                 
            newMediaQueries.forEach(mq => {
              mediaNode.parent.insertBefore(mediaNode, mq);
            });
            mediaNode.remove();
          });

          // MARK: - - Single CQ
          // Single container queries: generate clamp from the defined container query breakpoint to the smallest or largest breakpoint depending on the direction
          singleContainerQueries.forEach(({ mediaNode, declNodes }) => {
            const newContainerQueries = [];
            
            declNodes.forEach(decl => {

              const args = extractTwoValidClampArgs(decl.value);
              const [lower, upper] = args.map(val => convertToRem(val, rootFontSize, spacingSize, customProperties));
              if (!args || !lower || !upper) {
                decl.value = ` ${decl.value} /* Invalid clamp() values */`;
                return;
              }

              const screenValues = Object.values(containerScreens);   
              const containerNameMatches = mediaNode.params.match(/^([^\s(]+)\s*\(/)
              const containerName = containerNameMatches ? containerNameMatches[1].trim() : ''
              
              // 1) Create upper breakpoints 
              if (mediaNode.params.includes('>')) {

                const minContainer = mediaNode.params.match(/>=?([^)]+)/)[1].trim()
                const maxContainer = screenValues[screenValues.length - 1];

                const singleCQ = postcss.atRule({ name: 'container', params: `${containerName} (width >= ${minContainer})` });
                const clamp = generateClamp(lower, upper, minContainer, maxContainer, rootFontSize, spacingSize, true)
                
                singleCQ.append(postcss.decl({ prop: decl.prop, value: clamp }));
                newContainerQueries.push(singleCQ);

                decl.remove();

              } else if (mediaNode.params.includes('<')) {
                // 2) Create lower breakpoints

                const minContainer = screenValues[0];
                const maxContainer = mediaNode.params.match(/<([^)]+)/)[1].trim()

                const singleCQ = postcss.atRule({ name: 'container', params: `${containerName} ${mediaNode.params}` });
                const clamp = generateClamp(lower, upper, minContainer, maxContainer, rootFontSize, spacingSize, true)
                
                singleCQ.append(postcss.decl({ prop: decl.prop, value: clamp }));
                newContainerQueries.push(singleCQ);

                decl.remove();

              }
            });
            
            newContainerQueries.forEach(cq => {
              mediaNode.parent.insertBefore(mediaNode, cq);
            });
            mediaNode.remove();
          });

          // MARK: - - Double MQ
          // Nested-media queries: generate clamp between the two defined media query breakpoints
          doubleNestedMediaQueries.forEach(({ parentNode, mediaNode, declNodes }) => {
            declNodes.forEach(decl => { 

              const maxScreen = ([parentNode.params, mediaNode.params])
                .filter(p => p.includes('<'))
                .map(p => p.match(/<([^)]+)/)[1].trim())[0]
              
              const minScreen = ([parentNode.params, mediaNode.params])
                .filter(p => p.includes('>'))
                .map(p => p.match(/>=?([^)]+)/)[1].trim())[0]

              const args = extractTwoValidClampArgs(decl.value);
              const [lower, upper] = args.map(val => convertToRem(val, rootFontSize, spacingSize, customProperties));
              if (!args || !lower || !upper) {
                decl.value = ` ${decl.value} /* Invalid clamp() values */`;
                return;
              }

              decl.value = generateClamp(lower, upper, minScreen, maxScreen, rootFontSize, spacingSize, false)
            });
          });

          // MARK: - - Double CQ
          // Nested-container queries: generate clamp between the two defined container query breakpoints
          doubleNestedContainerQueries.forEach(({ parentNode, mediaNode, declNodes }) => {
            declNodes.forEach(decl => { 

              const maxContainer = ([parentNode.params, mediaNode.params])
                .filter(p => p.includes('<'))
                .map(p => p.match(/<([^)]+)/)[1].trim())[0]
              
              const minContainer = ([parentNode.params, mediaNode.params])
                .filter(p => p.includes('>'))
                .map(p => p.match(/>=?([^)]+)/)[1].trim())[0]

              const args = extractTwoValidClampArgs(decl.value);
              const [lower, upper] = args.map(val => convertToRem(val, rootFontSize, spacingSize, customProperties));
              if (!args || !lower || !upper) {
                decl.value = ` ${decl.value} /* Invalid clamp() values */`;
                return;
              }

              decl.value = generateClamp(lower, upper, minContainer, maxContainer, rootFontSize, spacingSize, true)
            });
          });
        }
      };
    }
  };
};

clampwind.postcss = true;
export default clampwind;