/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { GoogleGenAI } from "@google/genai";
import { 
  FileText, 
  Upload, 
  Copy, 
  Check, 
  Loader2, 
  AlertCircle, 
  Image as ImageIcon,
  FileSearch,
  Download,
  Trash2,
  Globe,
  Cpu,
  Moon,
  Sun
} from 'lucide-react';
import { useEffect } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Markdown from 'react-markdown';
import * as pdfjsLib from 'pdfjs-dist';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface OCRResult {
  text: string;
  timestamp: number;
  fileName: string;
}

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState<number>(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<OCRResult | null>(null);
  const [history, setHistory] = useState<OCRResult[]>(() => {
    const saved = localStorage.getItem('ocr_history');
    return saved ? JSON.parse(saved) : [];
  });
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showCitation, setShowCitation] = useState(false);
  const [citation, setCitation] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState("fr");
  const [selectedModel, setSelectedModel] = useState("gemini-3-flash-preview");
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('theme');
    return saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  const languages = [
    { code: "auto", name: "Détection automatique" },
    { code: "fr", name: "Français" },
    { code: "en", name: "Anglais" },
    { code: "de", name: "Allemand" },
    { code: "es", name: "Espagnol" },
    { code: "it", name: "Italien" },
    { code: "la", name: "Latin" },
  ];

  const models = [
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", description: "Rapide et efficace pour la plupart des documents." },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", description: "Haute précision pour les documents complexes ou manuscrits." },
  ];

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setError(null);
    setFiles(acceptedFiles);
    
    const newPreviews: string[] = [];
    let pageCount = 0;
    for (const file of acceptedFiles) {
      if (file.type === 'application/pdf') {
        try {
          const pdfPreviews = await generatePdfPreviews(file);
          newPreviews.push(...pdfPreviews);
          pageCount = pdfPreviews.length;
        } catch (err) {
          console.error("PDF Preview Error:", err);
          newPreviews.push(''); // Fallback or error placeholder
        }
      } else {
        newPreviews.push(URL.createObjectURL(file));
        pageCount = 1;
      }
    }
    setPreviews(newPreviews);
    setPdfPageCount(pageCount);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.webp'],
      'application/pdf': ['.pdf']
    },
    multiple: false
  });

  const generatePdfPreviews = async (file: File, maxPages: number = 20): Promise<string[]> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = Math.min(pdf.numPages, maxPages);
    const pagePreviews: string[] = [];

    // Reduce scale from 1.5 to 1.2 to save space while maintaining readability
    const scale = 1.2;

    for (let i = 1; i <= numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      if (context) {
        // @ts-ignore - pdfjs-dist types can be tricky between versions
        await page.render({ canvasContext: context, viewport }).promise;
        
        // Use image/jpeg with 0.7 quality instead of image/png to significantly reduce size
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
        if (dataUrl !== 'data:,' && dataUrl.length > 100) {
          pagePreviews.push(dataUrl);
        }
      }
    }
    
    if (pagePreviews.length === 0) {
      throw new Error("Aucune page n'a pu être convertie en image.");
    }
    return pagePreviews;
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = error => reject(error);
    });
  };

  const processOCR = async () => {
    if (files.length === 0) return;
    
    setIsProcessing(true);
    setError(null);
    setResult(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const model = selectedModel;
      
      const parts: any[] = [];

      if (files[0].type === 'application/pdf') {
        if (previews.length === 0) {
          throw new Error("Impossible de générer l'aperçu du PDF pour l'analyse.");
        }
        
        for (const preview of previews) {
          const base64Parts = preview.split(',');
          if (base64Parts.length >= 2) {
            const mimeMatch = base64Parts[0].match(/:(.*?);/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
            parts.push({
              inlineData: {
                data: base64Parts[1],
                mimeType: mimeType
              }
            });
          }
        }
      } else {
        const base64Data = await fileToBase64(files[0]);
        if (base64Data) {
          parts.push({
            inlineData: {
              data: base64Data,
              mimeType: files[0].type
            }
          });
        }
      }

      if (parts.length === 0) {
        throw new Error("Les données du document sont corrompues ou manquantes.");
      }

      console.log("Processing OCR with", parts.length, "pages/images in", selectedLanguage);

      const langName = languages.find(l => l.code === selectedLanguage)?.name || "Français";
      const langInstruction = selectedLanguage === "auto" 
        ? "Detect the language of the document automatically."
        : `The document is in ${langName}. Please perform the OCR in this language.`;

      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            ...parts,
            {
              text: `${langInstruction} Extract all text from these document pages accurately. Maintain the structure and formatting as much as possible. If it's a legal document, preserve the layout of articles, dates, and signatures. Output only the extracted text in Markdown format. If there are multiple pages, combine them into a single continuous document.`
            }
          ]
        },
        config: {
          systemInstruction: `You are an expert OCR assistant specialized in legal and historical documents. Your goal is to provide highly accurate text extraction in ${selectedLanguage === "auto" ? "the detected language" : langName}, preserving the original document's structure, including tables, lists, and headings. Do not add commentary unless necessary to clarify illegible parts. When multiple pages are provided, treat them as a single sequential document.`
        }
      });

      if (response.text) {
        const newResult = {
          text: response.text,
          timestamp: Date.now(),
          fileName: files[0].name
        };
        setResult(newResult);
        const newHistory = [newResult, ...history].slice(0, 5);
        setHistory(newHistory);
        localStorage.setItem('ocr_history', JSON.stringify(newHistory));
      } else {
        throw new Error("Aucun texte n'a pu être extrait.");
      }
    } catch (err: any) {
      console.error("OCR Error:", err);
      setError(err.message || "Une erreur est survenue lors du traitement.");
    } finally {
      setIsProcessing(false);
    }
  };

  const copyToClipboard = () => {
    if (result) {
      navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const generateCitation = () => {
    if (result) {
      const date = new Date(result.timestamp).getFullYear();
      const baseName = result.fileName.replace(/\.[^/.]+$/, "").replace(/_/g, " ");
      const formatted = `Source : ${baseName} (Extrait via Légiscribe OCR, ${date})`;
      setCitation(formatted);
      setShowCitation(true);
    }
  };

  const downloadText = () => {
    if (result) {
      const blob = new Blob([result.text], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${result.fileName.split('.')[0]}_ocr.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const reset = () => {
    setFiles([]);
    setPreviews([]);
    setResult(null);
    setError(null);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem('ocr_history');
  };

  const loadFromHistory = (item: OCRResult) => {
    setResult(item);
    // Scroll to results on mobile
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-[#FDFCF9] dark:bg-[#121212] flex flex-col transition-colors duration-300">
      {/* Header */}
      <header className="bg-white dark:bg-[#1A1A1A] border-b border-[#D4AF37]/20 px-8 py-5 flex items-center justify-between sticky top-0 z-10 shadow-sm transition-colors duration-300">
        <div className="flex items-center gap-4">
          <div className="bg-[#1A2B4B] p-2.5 rounded-lg shadow-inner">
            <FileSearch className="w-6 h-6 text-[#D4AF37]" />
          </div>
          <div>
            <h1 className="text-2xl font-serif font-bold text-[#1A2B4B] dark:text-[#D4AF37] tracking-tight">Légiscribe OCR</h1>
            <p className="text-[10px] text-[#D4AF37] font-bold uppercase tracking-[0.2em]">Assistant de transcription juridique</p>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors text-zinc-500 dark:text-zinc-400"
            title={theme === 'light' ? 'Passer au mode sombre' : 'Passer au mode clair'}
          >
            {theme === 'light' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
          </button>
          <div className="hidden md:flex flex-col items-end">
            <span className="text-[10px] font-serif italic text-zinc-400">Ex officio</span>
            <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">v1.0.0</span>
          </div>
          <div className="w-px h-8 bg-zinc-100 dark:bg-zinc-800" />
          <div className="bg-zinc-50 dark:bg-zinc-800 border border-zinc-100 dark:border-zinc-700 rounded-full px-3 py-1 flex items-center gap-2">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Serveur Actif</span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column: Input */}
        <div className="space-y-8">
          <section className="bg-white dark:bg-[#1E1E1E] rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-[0_2px_15px_-3px_rgba(0,0,0,0.07)] overflow-hidden transition-all hover:shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            <div className="p-5 border-b border-zinc-100 dark:border-zinc-800 bg-[#FDFCF9] dark:bg-[#1E1E1E] flex items-center justify-between">
              <h2 className="text-sm font-serif font-bold text-[#1A2B4B] dark:text-[#D4AF37] flex items-center gap-2">
                <Upload className="w-4 h-4 text-[#D4AF37]" />
                Source du Document
              </h2>
              {files.length > 0 && (
                <button 
                  onClick={reset}
                  className="text-[10px] text-zinc-400 hover:text-red-600 font-bold uppercase tracking-wider flex items-center gap-1.5 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Réinitialiser
                </button>
              )}
            </div>
            
            <div className="p-8">
              {files.length === 0 ? (
                <div 
                  {...getRootProps()} 
                  className={cn(
                    "border-2 border-dashed rounded-2xl p-16 flex flex-col items-center justify-center text-center transition-all cursor-pointer",
                    isDragActive ? "border-[#D4AF37] bg-[#FDFCF9] dark:bg-[#1E1E1E]" : "border-zinc-100 dark:border-zinc-800 hover:border-[#D4AF37]/50 hover:bg-[#FDFCF9]/50 dark:hover:bg-[#252525]"
                  )}
                >
                  <input {...getInputProps()} />
                  <div className="bg-zinc-50 dark:bg-zinc-800 p-5 rounded-full mb-6 shadow-inner">
                    <Upload className="w-10 h-10 text-zinc-300 dark:text-zinc-600" />
                  </div>
                  <h3 className="text-base font-serif font-bold text-[#1A2B4B] dark:text-[#D4AF37] mb-2">
                    {isDragActive ? "Déposez le folio ici" : "Déposez un document ou cliquez pour parcourir"}
                  </h3>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 max-w-xs leading-relaxed">
                    Images (JPG, PNG) ou PDF (jusqu'à 20 pages).<br/>Optimisé pour les archives de la Bibliothèque Nationale.
                  </p>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="relative aspect-[3/4] bg-[#FDFCF9] dark:bg-[#121212] rounded-2xl overflow-hidden border border-zinc-100 dark:border-zinc-800 shadow-inner group transition-colors">
                    {previews[0] ? (
                      <img 
                        src={previews[0]} 
                        alt="Preview" 
                        className="w-full h-full object-contain p-4"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-zinc-300 dark:text-zinc-700">
                        <FileText className="w-16 h-16 mb-4 opacity-20" />
                        <span className="text-xs font-serif italic">Aperçu en cours de chargement...</span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-[#1A2B4B]/80 to-transparent p-6 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0 flex justify-between items-end">
                      <p className="text-white text-xs font-medium truncate flex-1 mr-4">{files[0].name}</p>
                      {pdfPageCount > 1 && (
                        <span className="bg-[#D4AF37] text-[#1A2B4B] text-[10px] font-bold px-3 py-1 rounded-full shadow-lg">
                          {pdfPageCount} PAGES
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-[#1A2B4B] dark:text-[#D4AF37] uppercase tracking-wider flex items-center gap-2">
                        <Globe className="w-3 h-3 text-[#D4AF37]" />
                        Langue du document
                      </label>
                      <select
                        value={selectedLanguage}
                        onChange={(e) => setSelectedLanguage(e.target.value)}
                        className="w-full bg-[#FDFCF9] dark:bg-[#252525] border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm font-serif focus:outline-none focus:border-[#D4AF37] transition-colors text-[#1A1A1A] dark:text-[#E0E0E0]"
                      >
                        {languages.map((lang) => (
                          <option key={lang.code} value={lang.code} className="bg-white dark:bg-[#252525]">
                            {lang.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-[#1A2B4B] dark:text-[#D4AF37] uppercase tracking-wider flex items-center gap-2">
                        <Cpu className="w-3 h-3 text-[#D4AF37]" />
                        Moteur d'Analyse
                      </label>
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="w-full bg-[#FDFCF9] dark:bg-[#252525] border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm font-serif focus:outline-none focus:border-[#D4AF37] transition-colors text-[#1A1A1A] dark:text-[#E0E0E0]"
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id} className="bg-white dark:bg-[#252525]">
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <p className="text-[10px] text-zinc-400 italic px-1">
                    {models.find(m => m.id === selectedModel)?.description}
                  </p>

                  {error && (
                    <div className="bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 rounded-xl p-4 flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                      <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <p className="text-xs font-bold text-red-800 dark:text-red-400 uppercase tracking-wider mb-1">Erreur d'Analyse</p>
                        <p className="text-xs text-red-600 dark:text-red-300 leading-relaxed">{error}</p>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={processOCR}
                    disabled={isProcessing}
                    className={cn(
                      "w-full py-4 rounded-xl font-serif font-bold text-base flex items-center justify-center gap-3 transition-all shadow-md",
                      isProcessing 
                        ? "bg-zinc-100 text-zinc-400 cursor-not-allowed" 
                        : "bg-[#1A2B4B] text-white hover:bg-[#243B6B] active:scale-[0.98] hover:shadow-lg"
                    )}
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Analyse du manuscrit...
                      </>
                    ) : (
                      <>
                        <FileSearch className="w-5 h-5 text-[#D4AF37]" />
                        Lancer la Transcription
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </section>

          <div className="bg-[#1A2B4B] dark:bg-[#252525] border-l-4 border-[#D4AF37] rounded-r-2xl p-5 shadow-sm transition-colors">
            <h4 className="text-xs font-bold text-[#D4AF37] uppercase tracking-widest flex items-center gap-2 mb-2">
              <ImageIcon className="w-3.5 h-3.5" />
              Note de Recherche
            </h4>
            <p className="text-xs text-zinc-300 dark:text-zinc-400 leading-relaxed font-serif italic">
              "Pour une précision optimale sur les textes du XIXe et début XXe siècle, privilégiez les scans contrastés de Gallica."
            </p>
          </div>

          {history.length > 0 && (
            <section className="bg-white dark:bg-[#1E1E1E] rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-hidden transition-all">
              <div className="p-4 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-[#252525]/50 flex items-center justify-between">
                <h2 className="text-sm font-serif font-bold text-[#1A2B4B] dark:text-[#D4AF37] flex items-center gap-2">
                  <FileSearch className="w-4 h-4 text-[#D4AF37]" />
                  Historique Récent
                </h2>
                <button 
                  onClick={clearHistory}
                  className="text-[10px] text-zinc-400 hover:text-red-500 font-medium transition-colors"
                >
                  Effacer
                </button>
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {history.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => loadFromHistory(item)}
                    className="w-full p-4 text-left hover:bg-zinc-50 dark:hover:bg-[#252525] transition-colors flex items-center justify-between group"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-serif font-bold text-[#1A2B4B] dark:text-[#E0E0E0] truncate">{item.fileName}</p>
                      <p className="text-[10px] text-zinc-400 mt-0.5">
                        {new Date(item.timestamp).toLocaleDateString('fr-FR')} • {item.text.length} caractères
                      </p>
                    </div>
                    <FileText className="w-4 h-4 text-zinc-300 group-hover:text-[#D4AF37] transition-colors shrink-0 ml-4" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Right Column: Results */}
        <div className="space-y-8">
          <section className="bg-white dark:bg-[#1E1E1E] rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-[0_2px_15px_-3px_rgba(0,0,0,0.07)] h-full flex flex-col min-h-[700px] transition-all">
            <div className="p-5 border-b border-zinc-100 dark:border-zinc-800 bg-[#FDFCF9] dark:bg-[#1E1E1E] flex items-center justify-between shrink-0">
              <h2 className="text-sm font-serif font-bold text-[#1A2B4B] dark:text-[#D4AF37] flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#D4AF37]" />
                Transcription du Folio
              </h2>
              {result && (
                <div className="flex items-center gap-3">
                  <button 
                    onClick={generateCitation}
                    className="flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 rounded-lg transition-colors text-[#1A2B4B] dark:text-[#D4AF37] text-[10px] font-bold uppercase tracking-wider border border-zinc-100 dark:border-zinc-800"
                  >
                    <FileSearch className="w-3.5 h-3.5 text-[#D4AF37]" />
                    Citer
                  </button>
                  <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-800" />
                  <button 
                    onClick={copyToClipboard}
                    className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors text-zinc-500 dark:text-zinc-400 relative group"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <button 
                    onClick={downloadText}
                    className="p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors text-zinc-500 dark:text-zinc-400 relative group"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
            
            <div className="flex-1 p-10 overflow-y-auto relative bg-[#FDFCF9]/30 dark:bg-[#121212]/30">
              {showCitation && (
                <div className="mb-10 p-5 bg-[#1A2B4B] dark:bg-[#252525] border-l-4 border-[#D4AF37] rounded-r-xl animate-in fade-in slide-in-from-top-4 duration-500 shadow-md">
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[9px] font-bold text-[#D4AF37] uppercase tracking-[0.2em]">Référence Bibliographique</span>
                    <button onClick={() => setShowCitation(false)} className="text-zinc-400 hover:text-white transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p className="text-sm font-serif italic text-zinc-100 dark:text-zinc-300 leading-relaxed">{citation}</p>
                </div>
              )}

              {!result && !isProcessing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-300 dark:text-zinc-700 p-12 text-center">
                  <div className="bg-zinc-50 dark:bg-zinc-800 p-8 rounded-full mb-6 shadow-inner opacity-40">
                    <FileText className="w-16 h-16" />
                  </div>
                  <p className="text-base font-serif italic text-zinc-400 dark:text-zinc-600">Le texte transcrit apparaîtra ici...</p>
                  <p className="text-[10px] mt-4 uppercase tracking-[0.15em] font-bold opacity-30">En attente de document</p>
                </div>
              )}

              {isProcessing && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/90 dark:bg-[#121212]/90 backdrop-blur-md z-10">
                  <div className="relative mb-6">
                    <Loader2 className="w-16 h-16 text-[#1A2B4B] dark:text-[#D4AF37] animate-spin opacity-20" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <FileSearch className="w-6 h-6 text-[#D4AF37] animate-pulse" />
                    </div>
                  </div>
                  <p className="text-lg font-serif font-bold text-[#1A2B4B] dark:text-[#D4AF37]">Examen du document...</p>
                  <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-2 font-serif italic">Extraction de la substance juridique en cours</p>
                </div>
              )}

              {result && (
                <div className="markdown-body animate-in fade-in slide-in-from-bottom-4 duration-700">
                  <Markdown>{result.text}</Markdown>
                </div>
              )}
            </div>

            {result && (
              <div className="p-5 border-t border-zinc-100 dark:border-zinc-800 bg-[#FDFCF9] dark:bg-[#1E1E1E] shrink-0">
                <div className="flex items-center justify-center gap-4">
                  <div className="h-px w-12 bg-zinc-200 dark:bg-zinc-800" />
                  <p className="text-[9px] text-zinc-400 dark:text-zinc-600 font-bold uppercase tracking-[0.2em]">
                    Fin de la Transcription
                  </p>
                  <div className="h-px w-12 bg-zinc-200 dark:bg-zinc-800" />
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white dark:bg-[#1A1A1A] border-t border-[#D4AF37]/10 px-8 py-6 text-center transition-colors duration-300">
        <div className="flex flex-col items-center gap-2">
          <p className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-[0.3em]">
            Légiscribe OCR • Laboratoire de Recherche Juridique
          </p>
          <p className="text-[10px] text-zinc-300 dark:text-zinc-600 italic font-serif">
            Propulsé par Gemini 3 Flash • Optimisé pour les archives historiques de Gallica
          </p>
        </div>
      </footer>
    </div>
  );
}
