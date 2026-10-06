import { createContext, useContext } from 'react'

export type Notify = (text: string, error?: boolean) => void
export const NotifyContext = createContext<Notify>(() => {})
export const useNotify = () => useContext(NotifyContext)
