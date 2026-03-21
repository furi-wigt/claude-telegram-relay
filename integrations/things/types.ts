/** Shared types for Things 3 integration. */

export interface ThingsTask {
  id?: string;
  title: string;
  notes?: string;
  dueDate?: string;
  tags?: string[];
  list?: string;
  status: 'incomplete' | 'completed';
}

export interface NewThingsTask {
  title: string;
  notes?: string;
  dueDate?: Date;
  tags?: string[];
  listName?: string; // "Inbox", "Today", or project name
  when?: 'today' | 'evening' | Date;
}
