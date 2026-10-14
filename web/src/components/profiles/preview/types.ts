export interface PreviewDocument {
  id: string;
  section: string;
  title: string;
  path: string;
  date: string;
  body: string;
}

export interface PreviewModel {
  organization: string;
  service: string;
  title: string;
  description: string;
  loginNote: string;
  loginPrompt: string;
  failureText: string;
  successText: string;
  sections: string[];
  documents: PreviewDocument[];
  state: string;
  selectedDocumentId?: string;
}

export interface PreviewHandlers {
  unavailable?: (documentId: string) => void;
  showCatalog?: () => void;
  openFile?: (documentId: string) => void;
  showFiles?: () => void;
  logout?: () => void;
}
