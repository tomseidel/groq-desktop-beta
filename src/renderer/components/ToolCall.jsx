import React, { useState, useEffect } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

function ToolCall({ toolCall, toolResult }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [parsedArgs, setParsedArgs] = useState(null);
  const [parseErrorArgs, setParseErrorArgs] = useState(null);
  const [parseErrorMessage, setParseErrorMessage] = useState(null);

  useEffect(() => {
    setResult(null);
    setError(null);

    if (toolResult) {
      try {
        const parsedResult = JSON.parse(toolResult);
        if (parsedResult.error) {
          setError(parsedResult.error);
        } else {
          setResult(JSON.stringify(parsedResult, null, 2));
        }
      } catch (e) {
        setResult(toolResult);
      }
    }
  }, [toolResult]);

  useEffect(() => {
    setParsedArgs(null);
    setParseErrorArgs(null);
    setParseErrorMessage(null);
    if (toolCall?.function?.arguments) {
      try {
        setParsedArgs(JSON.parse(toolCall.function.arguments));
      } catch (e) {
        console.warn("Failed to parse tool call arguments JSON:", toolCall.function.arguments, e);
        setParseErrorArgs(toolCall.function.arguments);
        setParseErrorMessage(e.message);
      }
    } else {
      setParsedArgs({});
    }
  }, [toolCall?.function?.arguments]);

  const formatFunctionName = (name) => {
    if (!name) return '';
    
    const words = name.split('_');
    
    const firstWord = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    const restWords = words.slice(1);
    
    return [firstWord, ...restWords].join(' ');
  };

  if (!toolCall) return null;

  const { function: func } = toolCall;
  const functionName = func.name;
  const formattedName = formatFunctionName(functionName);

  const isPending = toolResult === null || toolResult === undefined;

  return (
    <div className="tool-call-container mt-2">
      <div className="border border-gray-700 rounded-lg p-3 shadow-sm">
        <div 
          className="flex justify-between items-center cursor-pointer"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="font-medium flex items-center">
            <span className="bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-xs px-2.5 py-0.5 rounded-full mr-2">
              Tool
            </span>
            <span>{formattedName}</span>
            {isPending && !isExpanded && (
              <svg className="animate-spin ml-2 h-4 w-4 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            )}
          </div>
          <button className="text-gray-500 ml-2 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            <svg 
              xmlns="http://www.w3.org/2000/svg" 
              className={`h-5 w-5 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} 
              fill="none" 
              viewBox="0 0 24 24" 
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {isExpanded && (
          <div className="mt-3 pt-3 border-t border-gray-600">
            <div className="text-sm font-medium text-gray-400 mb-1">Arguments:</div>
            <div className="rounded-md text-sm overflow-x-auto">
              <SyntaxHighlighter 
                language={parseErrorArgs ? "text" : "json"}
                style={vscDarkPlus}
                customStyle={{
                  borderRadius: '0.375rem', 
                  margin: 0,
                  padding: '0.5rem',
                  fontSize: '0.8rem',
                  backgroundColor: '#222326'
                }}
                wrapLongLines={true}
              >
                {parseErrorArgs !== null 
                  ? `// JSON Parse Error: ${parseErrorMessage}\n// Raw Arguments:\n${parseErrorArgs}` 
                  : JSON.stringify(parsedArgs, null, 2)
                }
              </SyntaxHighlighter>
            </div>

            {isPending && (
              <div className="text-sm flex items-center text-gray-400 mt-2">
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Executing...
              </div>
            )}

            {error && (
              <div className="text-red-500 text-sm mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
                <div className="font-medium mb-1">Error:</div>
                <pre className="whitespace-pre-wrap break-words">{error}</pre>
              </div>
            )}

            {result && !error && (
              <div className="mt-2">
                <div className="text-sm font-medium text-gray-400 mb-1">Result:</div>
                <div className="rounded-md text-sm overflow-x-auto">
                  <SyntaxHighlighter 
                    language="json" 
                    style={vscDarkPlus}
                    customStyle={{
                      borderRadius: '0.375rem', 
                      margin: 0,
                      padding: '0.5rem',
                      fontSize: '0.8rem',
                      backgroundColor: '#222326'
                    }}
                    wrapLongLines={true}
                  >
                    {result}
                  </SyntaxHighlighter>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ToolCall; 