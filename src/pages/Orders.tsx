import React, { useEffect, useState } from 'react';
import { collection, query, where, onSnapshot, getDocs, limit } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { useCart } from '../context/CartContext';
import { Order, Product } from '../types';
import { formatCurrency } from '../lib/utils';
import { format } from 'date-fns';
import { Link, useNavigate } from 'react-router-dom';
import { RotateCcw, Star } from 'lucide-react';

const getStatusLabel = (status: Order['status'], serviceType?: string) => {
  if (status === 'delivering') {
    if (serviceType === 'pickup') return 'Pronto p/ Retirada';
    if (serviceType === 'dine_in') return 'Servindo na Mesa';
    return 'Em Entrega';
  }
  const statusMap: Record<string, string> = {
    pending_payment: 'Aguardando Pagamento',
    preparing: 'Preparando',
    delivering: 'Em Entrega',
    completed: 'Concluído',
    cancelled: 'Cancelado'
  };
  return statusMap[status] || status;
};

const getServiceTypeLabel = (serviceType?: string) => {
  if (serviceType === 'pickup') return 'Retirada';
  if (serviceType === 'dine_in') return 'No Local';
  return 'Delivery';
};

export default function Orders() {
  const { user } = useAuth();
  const { addItem } = useCart();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [repeatingId, setRepeatingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    // A single where() + orderBy() on a different field needs a composite
    // Firestore index — if that index was never created in the console,
    // the query fails silently (no error surfaced) and the screen is stuck
    // on "Carregando pedidos..." forever. Filtering by userId only avoids
    // the index requirement entirely; sorting happens here instead.
    const q = query(
      collection(db, 'pix_test_orders'),
      where('userId', '==', user.uid),
      limit(500)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Order));
      list.sort((a, b) => b.createdAt - a.createdAt);
      setOrders(list);
      setLoading(false);
    }, (err) => {
      console.error('Erro ao carregar pedidos:', err);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleRepeat = async (e: React.MouseEvent, order: Order) => {
    e.preventDefault();
    e.stopPropagation();
    setRepeatingId(order.id);
    try {
      const snapshot = await getDocs(collection(db, 'products'));
      const currentProducts = new Map(snapshot.docs.map(d => [d.id, { id: d.id, ...d.data() } as Product]));

      let addedCount = 0;
      const unavailable: string[] = [];

      for (const item of order.items) {
        const current = currentProducts.get(item.product.id);
        if (!current || !current.available) {
          unavailable.push(item.product.name);
          continue;
        }
        const unitPrice = ((item.selectedSize === '2 pedaços' || item.selectedSize === '2 itens') && current.priceOption2 !== undefined)
          ? current.priceOption2
          : current.price;

        addItem({
          product: current,
          quantity: item.quantity,
          selectedOption: item.selectedOption,
          selectedSize: item.selectedSize,
          totalPrice: unitPrice
        });
        addedCount++;
      }

      if (addedCount === 0) {
        setNotice('Nenhum item desse pedido está mais disponível no cardápio.');
        return;
      }

      if (unavailable.length > 0) {
        setNotice(`${addedCount} item(ns) adicionados. Indisponíveis: ${unavailable.join(', ')}.`);
        setTimeout(() => navigate('/cart'), 1200);
      } else {
        navigate('/cart');
      }
    } finally {
      setRepeatingId(null);
    }
  };

  if (loading) return <div className="p-8 text-xs font-bold text-gray-500 uppercase tracking-widest text-center">Carregando pedidos...</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h1 className="text-xl font-black text-gray-900 mb-6 uppercase tracking-wider">Meus Pedidos</h1>

      {notice && (
        <div className="mb-4 bg-amber-50 border border-amber-200 text-amber-900 text-xs font-bold rounded-lg p-3">
          {notice}
        </div>
      )}

      {orders.length === 0 ? (
        <p className="text-xs font-bold text-gray-500 uppercase tracking-widest text-center py-12">Nenhum pedido encontrado.</p>
      ) : (
        <div className="space-y-4">
          {orders.map(order => (
            <div
              key={order.id}
              className="bg-white shadow-sm rounded-xl border border-gray-100 overflow-hidden hover:shadow-md transition-shadow"
            >
              <Link to={`/orders/${order.id}`} className="block p-5">
                <div className="flex justify-between items-center mb-3">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[9px] font-black uppercase tracking-wider text-brand bg-brand/10 px-1.5 py-0.5 rounded border border-brand/20">
                        {getServiceTypeLabel(order.serviceType)}
                      </span>
                      <span className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Pedido #{order.id.slice(-6).toUpperCase()}</span>
                    </div>
                    <h3 className="text-sm font-bold text-gray-900 mt-1">
                      {format(new Date(order.createdAt), 'dd/MM/yyyy HH:mm')}
                    </h3>
                  </div>
                  <div className="text-right">
                    <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest ${
                      order.status === 'pending_payment' ? 'bg-orange-100 text-orange-800' :
                      order.status === 'preparing' ? 'bg-blue-100 text-blue-800' :
                      order.status === 'delivering' ? 'bg-purple-100 text-purple-800' :
                      order.status === 'completed' ? 'bg-green-100 text-green-800' :
                      'bg-red-100 text-red-800'
                    }`}>
                      {getStatusLabel(order.status, order.serviceType)}
                    </span>
                    <div className="mt-1 font-black text-gray-900">{formatCurrency(order.total)}</div>
                  </div>
                </div>
                <p className="text-[10px] text-gray-500 truncate border-t border-gray-50 pt-3" translate="no">
                  {order.items.map(i => `${i.quantity}x ${i.product.name}`).join(', ')}
                </p>
                {((order.pointsEarned || 0) > 0 || (order.pointsRedeemed || 0) > 0) && (
                  <div className="flex items-center gap-3 mt-2 flex-wrap">
                    {(order.pointsEarned || 0) > 0 && (
                      <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-amber-700">
                        <Star size={10} className="fill-amber-500 text-amber-500" />
                        {order.pointsCredited ? `+${order.pointsEarned} pts ganhos` : `+${order.pointsEarned} pts ao concluir`}
                      </span>
                    )}
                    {(order.pointsRedeemed || 0) > 0 && (
                      <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-gray-400">
                        <Star size={10} className="fill-gray-300 text-gray-300" />
                        -{order.pointsRedeemed} pts usados
                      </span>
                    )}
                  </div>
                )}
              </Link>
              <div className="border-t border-gray-50 px-5 py-3 flex justify-end">
                <button
                  onClick={(e) => handleRepeat(e, order)}
                  disabled={repeatingId === order.id}
                  className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-brand hover:text-brand-dark transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <RotateCcw size={13} className={repeatingId === order.id ? 'animate-spin' : ''} />
                  Repetir Pedido
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
