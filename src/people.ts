import type { Person } from './types';
export const people: Person[] = [
  { id: 'lucia', name: 'Lucía Martín', role: 'customer', initials: 'LM', color: '#a6b5fa' },
  { id: 'bruno', name: 'Bruno Vidal', role: 'customer', initials: 'BV', color: '#a4d9bc' },
  { id: 'carla', name: 'Carla Ríos', role: 'customer', initials: 'CR', color: '#edc18e' },
  { id: 'diego', name: 'Diego Salas', role: 'customer', initials: 'DS', color: '#bcb0ea' },
  { id: 'elena', name: 'Elena Costa', role: 'customer', initials: 'EC', color: '#99cbd7' },
  { id: 'hugo', name: 'Hugo Pérez', role: 'customer', initials: 'HP', color: '#dbb3bf' },
  { id: 'ines', name: 'Inés López', role: 'customer', initials: 'IL', color: '#c2d49d' },
  { id: 'omar', name: 'Omar León', role: 'customer', initials: 'OL', color: '#c0c7ce' },
  { id: 'marta', name: 'Marta Sanz', role: 'operator', initials: 'MS', color: '#acd5cc' },
  { id: 'pablo', name: 'Pablo Gil', role: 'operator', initials: 'PG', color: '#c3b8e6' },
];
export function person(id: string) {
  return people.find((p) => p.id === id);
}
